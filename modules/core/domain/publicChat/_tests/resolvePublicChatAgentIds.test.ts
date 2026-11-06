import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {Types} from "mongoose";
import request from "supertest";
import {Router} from "express";

vi.mock("@coreModule/utilities/middlewares/authMW", async () => (await import("@coreModule/_tests/httpHarness")).authMWStub);

import {appFor, callerHeader} from "@coreModule/_tests/httpHarness";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {mountActions} from "@coreModule/api/crudRouterFactory";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {actionPermissionEntries, actionPermissionTag} from "@coreModule/utilities/security/actionPermissions";
import Channel from "@coreModule/database/schemas/channel/channel";
import {ChannelActions} from "@coreModule/database/schemas/channel/channel.actions";
import Role from "@coreModule/database/schemas/role/role";
import RolePermission from "@coreModule/database/schemas/rolePermission/rolePermission";
import User from "@coreModule/database/schemas/user/user";
import {ANSWER_WEBSITE_CHATS, resolvePublicChatAgentIds} from "@coreModule/domain/publicChat/handoff";

const router = Router();
mountActions(router, ChannelActions, Channel);
const app = appFor([{basePath: "/api/user/chats/channels", router}]);

const answerTag = actionPermissionTag(Channel, ANSWER_WEBSITE_CHATS, "self")!;
const companyId = new Types.ObjectId();
const adminRole = new Types.ObjectId();
const chatAgentRole = new Types.ObjectId();
const otherRole = new Types.ObjectId();
const answerPermission = new Types.ObjectId();
const agent = new Types.ObjectId();
const chatAgent = new Types.ObjectId();
const clerk = new Types.ObjectId();
const bot = new Types.ObjectId();
const inactive = new Types.ObjectId();

const member = (_id: Types.ObjectId, role: Types.ObjectId, extra: Record<string, unknown> = {}, active = "active") => ({
    _id,
    username: `${_id.toString()}@test.local`,
    companies: [companyId],
    roles: [{company: companyId, active, roles: [role]}],
    ...extra,
});

beforeAll(async () => {
    await connectTestDatabase();
    // Raw rows: only the fields the lookup reads.
    await RolePermission.collection.insertOne({_id: answerPermission, tag: answerTag, group: "Channels"});
    await Role.collection.insertMany([
        {_id: adminRole, company: companyId, isAdmin: true, permissions: [], deletedAt: null},
        {_id: chatAgentRole, company: companyId, isAdmin: false, permissions: [answerPermission], deletedAt: null},
        {_id: otherRole, company: companyId, isAdmin: false, permissions: [], deletedAt: null},
    ]);
    await User.collection.insertMany([
        member(agent, adminRole),
        member(chatAgent, chatAgentRole),
        member(clerk, otherRole),
        member(bot, adminRole, {isBot: true}),
        member(inactive, adminRole, {}, "inactive"),
    ]);
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

describe("answering website chats (D71)", {timeout: 60000}, () => {
    it("is one grantable action permission for joining, releasing and closing", () => {
        const channelTags = actionPermissionEntries().map((entry) => entry.tag).filter((tag) => tag.startsWith("channels["));
        expect(channelTags).toEqual(expect.arrayContaining([answerTag]));
        expect(channelTags.some((tag) => /:(join|release|close)\]$/.test(tag))).toBe(false);
    });

    it("refuses join, release and close without it", async () => {
        const caller = {userId: clerk.toString(), companyId: companyId.toString(), permissions: []};
        for (const method of ["join", "release", "close"]) {
            const response = await request(app).post(`/api/user/chats/channels/${method}`)
                .set(callerHeader(caller)).send({_id: new Types.ObjectId().toString()});
            expect(response.status).toBe(403);
        }
    });

    // It used to call `.noDeleted()` on a User query; users have no soft delete, so the lookup threw and every
    // handoff found no agent.
    it("notifies the active human members of admin roles and of roles granted it", async () => {
        const ids = await withTenant(companyId, () => resolvePublicChatAgentIds(companyId));
        expect(ids.sort()).toEqual([agent.toString(), chatAgent.toString()].sort());
    });
});

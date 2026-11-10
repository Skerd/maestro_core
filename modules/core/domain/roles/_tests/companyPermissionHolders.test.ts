import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {Types} from "mongoose";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import Role from "@coreModule/database/schemas/role/role";
import RolePermission from "@coreModule/database/schemas/rolePermission/rolePermission";
import User from "@coreModule/database/schemas/user/user";
import {companyMemberIdsWithPermission} from "@coreModule/domain/roles/companyPermissionHolders";

const TAG = "widgets[action:approve]";
const companyId = new Types.ObjectId();
const otherCompanyId = new Types.ObjectId();
const adminRole = new Types.ObjectId();
const approverRole = new Types.ObjectId();
const clerkRole = new Types.ObjectId();
const foreignApproverRole = new Types.ObjectId();
const permission = new Types.ObjectId();
const admin = new Types.ObjectId();
const approver = new Types.ObjectId();
const clerk = new Types.ObjectId();
const visitor = new Types.ObjectId();
const inactiveApprover = new Types.ObjectId();
const foreignApprover = new Types.ObjectId();

const member = (_id: Types.ObjectId, company: Types.ObjectId, role: Types.ObjectId, extra: Record<string, unknown> = {}, active = "active") => ({
    _id,
    username: `${_id.toString()}@test.local`,
    companies: [company],
    roles: [{company, active, roles: [role]}],
    ...extra,
});

beforeAll(async () => {
    await connectTestDatabase();
    // Raw rows: only the fields the lookup reads.
    await RolePermission.collection.insertOne({_id: permission, tag: TAG, group: "Widgets"});
    await Role.collection.insertMany([
        {_id: adminRole, company: companyId, slug: "admin", isAdmin: true, permissions: [], deletedAt: null},
        {_id: approverRole, company: companyId, slug: "approver", isAdmin: false, permissions: [permission], deletedAt: null},
        {_id: clerkRole, company: companyId, slug: "clerk", isAdmin: false, permissions: [], deletedAt: null},
        {_id: foreignApproverRole, company: otherCompanyId, slug: "approver", isAdmin: false, permissions: [permission], deletedAt: null},
    ]);
    await User.collection.insertMany([
        member(admin, companyId, adminRole),
        member(approver, companyId, approverRole),
        member(clerk, companyId, clerkRole),
        member(visitor, companyId, approverRole, {isVisitor: true}),
        member(inactiveApprover, companyId, approverRole, {}, "inactive"),
        member(foreignApprover, otherCompanyId, foreignApproverRole),
    ]);
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

describe("companyMemberIdsWithPermission", {timeout: 60000}, () => {
    it("finds the active human members of admin roles and of roles granted the tag, in that company only", async () => {
        const ids = await withTenant(companyId, () => companyMemberIdsWithPermission(companyId, TAG));
        expect(ids.sort()).toEqual([admin.toString(), approver.toString()].sort());
    });

    it("counts only admin roles without a tag or for a tag nobody has", async () => {
        expect(await withTenant(companyId, () => companyMemberIdsWithPermission(companyId, undefined))).toEqual([admin.toString()]);
        expect(await withTenant(companyId, () => companyMemberIdsWithPermission(companyId, "widgets[action:unknown]"))).toEqual([admin.toString()]);
    });
});

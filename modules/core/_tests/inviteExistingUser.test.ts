import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import request from "supertest";

const company = new ObjectId();
const otherCompany = new ObjectId();
const callerId = new ObjectId();

// The harness stub sets no inviter and a plain company; the invite reads the inviter's name and the company's roles.
vi.mock("@coreModule/utilities/middlewares/authMW", async () => {
    const {authMWStub} = await import("@coreModule/_tests/httpHarness");
    const {default: RoleModel} = await import("@coreModule/database/schemas/role/role");
    return {
        default: (scope?: string) => (req: {body: Record<string, unknown>}, res: unknown, next: () => void) => {
            req.body.userInfo = {_id: callerId, name: "Marco", surname: "Rossi", username: "marco@example.com"};
            return authMWStub.default(scope)(req, res, () => {
                req.body.company = {...(req.body.company as object), name: "Vista", getAllRoles: () => RoleModel.find({company}).lean()};
                next();
            });
        },
    };
});
vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const {addedToCompanyMails} = vi.hoisted(() => ({addedToCompanyMails: [] as unknown[][]}));
vi.mock("@coreModule/utilities/emails/notifiers", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@coreModule/utilities/emails/notifiers")>()),
    sendAddedToCompanyMail: async (...args: unknown[]) => {
        addedToCompanyMails.push(args);
    },
}));

import {allPermissionTags, appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import User from "@coreModule/database/schemas/user/user";
import Role from "@coreModule/database/schemas/role/role";
import * as usersRoute from "@coreModule/api/company/private/users";

const app = appFor([{basePath: "/api/company/users", router: usersRoute.router, module: "core"}]);
const staff: TestCaller = {userId: callerId.toString(), companyId: company.toString(), isAdmin: false, permissions: allPermissionTags([User, Role]), modules: ["core"]};

beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    addedToCompanyMails.length = 0;
    await Promise.all([User.collection.deleteMany({}), Role.collection.deleteMany({})]);
});

/** Ann already has an account, in another company, and reads Albanian. */
async function insertAnn(): Promise<ObjectId> {
    const userId = new ObjectId();
    await User.collection.insertOne({
        _id: userId,
        username: "ann@example.com",
        name: "Ann",
        surname: "Lee",
        preferredLanguage: "sq-AL",
        companies: [otherCompany],
        roles: [{company: otherCompany, roles: [new ObjectId()], active: "active"}],
        isBot: false,
        registerDate: new Date(),
        deletedAt: null,
    });
    return userId;
}

describe("inviting someone who already has an account (D187)", {timeout: 30000}, () => {
    it("adds them and emails them after commit, in their language, naming the role in it", async () => {
        const roleId = new ObjectId();
        await Role.collection.insertOne({_id: roleId, company, name: "Web Client", slug: "vista:default:webclient", isAdmin: false, isSignupDefault: false, permissions: [], deletedAt: null});
        const userId = await insertAnn();

        const res = await request(app).put("/api/company/users/invite").set(callerHeader(staff))
            .send({email: "ann@example.com", name: "Ann", surname: "Lee", userRole: roleId.toString(), welcomeMessage: "See you Monday."});

        expect(res.body.error_code ?? "ok").toBe("ok");
        const added = await User.collection.findOne({_id: userId});
        expect(added?.roles.map((r: {company: ObjectId}) => r.company.toString())).toContain(company.toString());
        expect(addedToCompanyMails).toEqual([
            [company.toString(), "ann@example.com", "Ann Lee", "See you Monday.", "Marco Rossi", "Vista", "Klient uebi", "sq-AL"],
        ]);
    });

    it("sends nothing when the invite fails", async () => {
        await insertAnn();
        const res = await request(app).put("/api/company/users/invite").set(callerHeader(staff))
            .send({email: "ann@example.com", name: "Ann", surname: "Lee", userRole: new ObjectId().toString()});

        expect(res.status).not.toBe(200);
        expect(addedToCompanyMails).toEqual([]);
    });
});

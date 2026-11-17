import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import bcrypt from "bcrypt";
import request from "supertest";

vi.mock("@coreModule/utilities/middlewares/rateLimiter", () => ({
    rateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("@coreModule/connections/pushNotificationToUsers", () => ({pushNotificationToUsers: vi.fn()}));

import {appFor} from "@coreModule/_tests/httpHarness";
import Company from "@coreModule/database/schemas/company/company";
import Role from "@coreModule/database/schemas/role/role";
import User from "@coreModule/database/schemas/user/user";
import Notification from "@coreModule/database/schemas/notification/notification";
import RolePermission from "@coreModule/database/schemas/rolePermission/rolePermission";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import {registerNotificationEventHandlers} from "@coreModule/domain/notifications/notificationDomainService";
import {notificationText} from "@coreModule/domain/notifications/notificationTexts";
import {router as loginRouter} from "@coreModule/api/user/public/login";

const app = appFor([{basePath: "/api/user/login", router: loginRouter, module: "core"}]);

const company = new ObjectId();
const role = new ObjectId();
const userId = new ObjectId();
const password = "Secret#Pass1";
const chromeOnMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    registerNotificationEventHandlers();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    for (const collection of await mongoose.connection.db!.collections()) {
        await collection.deleteMany({});
    }
    await Company.collection.insertOne({_id: company, company, name: "Estates", vat: "E", allowedDomains: ["*"], isActive: true, deletedAt: null});
    await Role.collection.insertOne({_id: role, name: "Manager", slug: "manager", company, isSignupDefault: false, isAdmin: false, permissions: []});
    await User.collection.insertOne({
        _id: userId, username: "manager@estates.com", password: await bcrypt.hash(password, 10), name: "Pat", surname: "Manager",
        fullName: "Pat Manager", isEmailVerified: true, companies: [company], mfaSecret: "",
        roles: [{_id: new ObjectId(), company, roles: [role], rolesCount: 1, active: "active", unsuccessfulLogins: 0, lockedOutUntil: null}],
    });
});

const signIn = (userAgent: string) =>
    request(app).post("/api/user/login")
        .set({"Origin": "http://localhost:5173", "x-device-id": "laptop", "User-Agent": userAgent})
        .send({username: "manager@estates.com", password});

const notices = async (count: number) => {
    await vi.waitFor(async () => expect(await Notification.collection.countDocuments({receiver: userId})).toBe(count));
    const rows = await Notification.collection.find({receiver: userId}).sort({_id: 1}).toArray();
    return rows.map((row) => [row.code, notificationText(row.code, row.params, "en-US")]);
};

// TD-B237: every sign-in raised both USER_LOGGED_IN and USER_LOGGED_IN_NEW_DEVICE, and the text showed the raw IP
// ("from client (::1)").
describe("sign-in notices", () => {
    it("raise one notice per sign-in, the new-device one only for a new device, naming the browser and system", async () => {
        expect((await signIn(chromeOnMac)).status).toBe(200);
        expect(await notices(1)).toEqual([
            ["USER_LOGGED_IN_NEW_DEVICE", "Your account was used to sign in from a new device: Chrome on macOS"],
        ]);

        expect((await signIn(chromeOnMac)).status).toBe(200);
        expect((await notices(2))[1]).toEqual(["USER_LOGGED_IN", "New sign-in to your account from Chrome on macOS"]);
    });

    it("say only that someone signed in when the client names no browser", async () => {
        await signIn("curl/8.7.1");
        await signIn("curl/8.7.1");

        expect((await notices(2))[1]).toEqual(["USER_LOGGED_IN", "New sign-in to your account"]);
    });
});

const contents = async (count: number) => {
    await vi.waitFor(async () => expect(await Notification.collection.countDocuments({receiver: userId})).toBe(count));
    const rows = await Notification.collection.find({receiver: userId}).sort({_id: 1}).toArray();
    return rows.map((row) => row.content?.accountTab);
};

const grant = async (tag: string) => {
    const {insertedId} = await RolePermission.collection.insertOne({tag, name: tag, group: "Core", module: "core", alwaysActive: false});
    await Role.collection.updateOne({_id: role}, {$push: {permissions: insertedId}});
};

const unlinkTelegram = () => emitNotificationEvent(NotificationEventCodes.TELEGRAM_UNLINKED, {
    receiverIds: [userId.toString()], payload: {companyId: company.toString(), languageCode: "en-US"},
});

// TD-F133: the account notices opened nothing. They open their tab now, but only for a receiver who can open it there:
// a Web Client has no read of their sessions or Telegram, and a link would land them on Forbidden.
describe("account notice links", () => {
    it("open Security once the receiver may read their own sessions", async () => {
        await signIn(chromeOnMac);
        expect(await contents(1)).toEqual([undefined]);

        await grant("usersessions[read:self:createdAt]");
        await signIn(chromeOnMac);
        expect(await contents(2)).toEqual([undefined, "security"]);
    });

    it("open Apps once the receiver may see their Telegram link", async () => {
        unlinkTelegram();
        expect(await contents(1)).toEqual([undefined]);

        await grant("users[read:self:telegram]");
        unlinkTelegram();
        expect(await contents(2)).toEqual([undefined, "apps"]);
    });
});

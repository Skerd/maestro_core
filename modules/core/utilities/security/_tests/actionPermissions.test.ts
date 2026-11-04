import {afterEach, describe, expect, it, vi} from "vitest";
import mongoose, {Schema} from "mongoose";
import request from "supertest";
import {Router} from "express";

vi.mock("@coreModule/utilities/middlewares/authMW", async () => (await import("@coreModule/_tests/httpHarness")).authMWStub);

import {appFor, callerHeader, type TestCaller} from "@coreModule/_tests/httpHarness";
import {action} from "@coreModule/api/actionDecorator";
import {mountActions} from "@coreModule/api/crudRouterFactory";
import {actionPermissionEntries, actionPermissionTag} from "@coreModule/utilities/security/actionPermissions";

const Booking = mongoose.model("ActionPermissionBooking", new Schema({title: String}));
const ran: string[] = [];

class BookingActions {
    @action({auth: "private"})
    async confirmBooking() {
        ran.push("confirmBooking");
        return {ok: true};
    }

    @action({auth: false})
    async publicQuote() {
        ran.push("publicQuote");
        return {ok: true};
    }

    @action({auth: "public"})
    async publicLink() {
        ran.push("publicLink");
        return {ok: true};
    }

    @action({auth: "private", selfService: true})
    async myPreferences() {
        ran.push("myPreferences");
        return {ok: true};
    }
}

const router = Router();
mountActions(router, BookingActions, Booking);
const app = appFor([{basePath: "/api/bookings", router, module: "pilot"}]);

const confirmSelf = actionPermissionTag(Booking, "confirmBooking", "self")!;
const caller = (permissions: string[]): TestCaller => ({userId: "u1", companyId: "6a0000000000000000000001", permissions});
const confirm = (permissions: string[]) => request(app).post("/api/bookings/confirmBooking").set(callerHeader(caller(permissions))).send({});

afterEach(() => {
    delete process.env.ACTION_PERMISSION_ENFORCE;
    ran.length = 0;
});

describe("action permissions (D14)", () => {
    it("names each authenticated action as a permission of its model, in the model's group", () => {
        expect(confirmSelf).toBe("actionpermissionbookings[action:self:confirmBooking]");
        expect(actionPermissionEntries()).toEqual(expect.arrayContaining([
            {name: "Confirm booking", group: "Actionpermissionbookings", tag: confirmSelf, alwaysActive: false, module: "core"},
            expect.objectContaining({tag: "actionpermissionbookings[action:others:confirmBooking]"}),
        ]));
        // A public action has no caller to hold a permission.
        expect(actionPermissionEntries().some((entry) => /publicQuote|publicLink|myPreferences/.test(entry.tag))).toBe(false);
    });

    it("refuses an enforced module's action before its body when the role lacks the permission", async () => {
        process.env.ACTION_PERMISSION_ENFORCE = "pilot";
        const refused = await confirm([]);
        expect(refused.status).toBe(403);
        expect(refused.body.error_code).toBe("user_permissions_not_sufficient");
        expect(ran).toEqual([]);

        const allowed = await confirm([confirmSelf]);
        expect(allowed.status).toBe(200);
        expect(ran).toEqual(["confirmBooking"]);
    });

    it("only logs in a module that is not enforced yet", async () => {
        process.env.ACTION_PERMISSION_ENFORCE = "someOtherModule";
        expect((await confirm([])).status).toBe(200);
        expect(ran).toEqual(["confirmBooking"]);
    });

    it("lets any signed-in caller run a self-service action", async () => {
        process.env.ACTION_PERMISSION_ENFORCE = "*";
        expect((await request(app).post("/api/bookings/myPreferences").set(callerHeader(caller([]))).send({})).status).toBe(200);
        expect(ran).toEqual(["myPreferences"]);
    });

    it("leaves public actions alone", async () => {
        process.env.ACTION_PERMISSION_ENFORCE = "*";
        expect((await request(app).post("/api/bookings/publicQuote").send({})).status).toBe(200);
        // A public route still authenticates nothing: the harness takes the caller from the header.
        expect((await request(app).post("/api/bookings/publicLink").set(callerHeader(caller([]))).send({})).status).toBe(200);
        expect(ran).toEqual(["publicQuote", "publicLink"]);
    });
});

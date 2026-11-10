import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {Types} from "mongoose";

const mocks = vi.hoisted(() => ({push: vi.fn()}));
// The WebSocket push is recorded, not sent.
vi.mock("@coreModule/connections/pushNotificationToUsers", () => ({pushNotificationToUsers: mocks.push}));

import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import User from "@coreModule/database/schemas/user/user";
import Notification from "@coreModule/database/schemas/notification/notification";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {createAndPushNotification, filterUnmutedReceivers, registerNotificationEventHandlers} from "@coreModule/domain/notifications/notificationDomainService";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import {NotificationCategory} from "armonia/src/modules/core/api/user/private/notifications/notifications.enum";

const companyId = new Types.ObjectId();
const otherCompanyId = new Types.ObjectId();
const ann = new Types.ObjectId();
const bo = new Types.ObjectId();

const member = (_id: Types.ObjectId) => ({
    _id,
    username: `${_id.toString()}@test.local`,
    companies: [companyId, otherCompanyId],
    roles: [
        {company: companyId, active: "active", roles: []},
        {company: otherCompanyId, active: "active", roles: []},
    ],
});

beforeAll(async () => {
    await connectTestDatabase();
    await User.collection.insertMany([member(ann), member(bo)]);
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    mocks.push.mockReset();
    await Notification.collection.deleteMany({});
    await User.collection.updateMany({}, {$unset: {"roles.$[].mutedNotifications": ""}});
});

const notify = (receiver: Types.ObjectId, company: Types.ObjectId, extra: Record<string, unknown> = {}) =>
    withTenant(company, () => createAndPushNotification({
        receiver,
        company,
        code: "WIDGET_APPROVED",
        description: "Widget approved",
        params: {title: "Blue widget", variant: "withNotes"},
        ...extra,
    }));

describe("notification code + params (D117)", {timeout: 60000}, () => {
    it("stores the params next to the English fallback and pushes them to the panel", async () => {
        const created = await notify(ann, companyId);

        expect(created?.params).toEqual({title: "Blue widget", variant: "withNotes"});
        expect(created?.description).toBe("Widget approved");
        const [[userIds, [dto]]] = mocks.push.mock.calls;
        expect(userIds).toEqual([ann.toString()]);
        expect(dto).toMatchObject({code: "WIDGET_APPROVED", description: "Widget approved", params: {title: "Blue widget", variant: "withNotes"}});
    });
});

describe("per-type opt-out (D117)", {timeout: 60000}, () => {
    it("skips a receiver who turned the code off in that company, and only there", async () => {
        await userService.setNotificationMuted(ann, companyId, "WIDGET_APPROVED", true);

        expect(await notify(ann, companyId)).toBeNull();
        expect(await notify(bo, companyId)).not.toBeNull();
        expect(await notify(ann, otherCompanyId)).not.toBeNull();
        expect(await notify(ann, companyId, {code: "WIDGET_REJECTED"})).not.toBeNull();
        expect(await Notification.collection.countDocuments({receiver: ann, company: companyId})).toBe(1);
        expect(mocks.push).toHaveBeenCalledTimes(3);
    });

    it("always delivers security notices", async () => {
        await userService.setNotificationMuted(ann, companyId, "WIDGET_APPROVED", true);
        expect(await notify(ann, companyId, {category: NotificationCategory.SECURITY})).not.toBeNull();
    });

    it("turns a type back on, and keeps one entry however often it is turned off", async () => {
        await userService.setNotificationMuted(ann, companyId, "WIDGET_APPROVED", true);
        await userService.setNotificationMuted(ann, companyId, "WIDGET_APPROVED", true);
        await userService.setNotificationMuted(ann, companyId, "WIDGET_REJECTED", true);
        expect(await userService.findMutedNotificationCodes(ann, companyId)).toEqual(["WIDGET_APPROVED", "WIDGET_REJECTED"]);
        expect(await userService.findMutedNotificationCodes(ann, otherCompanyId)).toEqual([]);

        await userService.setNotificationMuted(ann, companyId, "WIDGET_APPROVED", false);
        expect(await userService.findMutedNotificationCodes(ann, companyId)).toEqual(["WIDGET_REJECTED"]);
        expect(await notify(ann, companyId)).not.toBeNull();
    });

    it("filters a module's own email recipients the same way", async () => {
        await userService.setNotificationMuted(bo, companyId, "WIDGET_APPROVED", true);
        expect(await filterUnmutedReceivers([ann.toString(), bo.toString(), "not-an-id"], companyId, "WIDGET_APPROVED")).toEqual([ann.toString()]);
        expect(await filterUnmutedReceivers([ann.toString(), bo.toString()], otherCompanyId, "WIDGET_APPROVED")).toEqual([ann.toString(), bo.toString()]);
    });
});

// TD-B173: core notices stored only English text, so the panel could not translate them.
describe("core notices carry their message values (D117)", {timeout: 60000}, () => {
    beforeAll(() => {
        registerNotificationEventHandlers();
    });

    const deliver = async (code: string, payload: Record<string, unknown>) => {
        emitNotificationEvent(code, {receiverIds: [ann.toString()], payload: {companyId: companyId.toString(), ...payload}});
        await vi.waitFor(async () => expect(await Notification.collection.countDocuments({code})).toBe(1));
        return Notification.collection.findOne({code});
    };

    it("stores who did what, and the variant, next to the English text", async () => {
        const status = await deliver(NotificationEventCodes.ACCOUNT_STATUS_CHANGED_BY_ADMIN, {activated: false, actorUsername: "Ada"});
        expect(status).toMatchObject({params: {actor: "Ada", variant: "deactivated"}, description: "Ada deactivated your account for this company"});

        const mention = await deliver(NotificationEventCodes.MESSAGE_MENTIONED, {senderId: bo.toString(), senderUsername: "Bo", channelName: "Sales"});
        expect(mention).toMatchObject({params: {sender: "Bo", channel: "Sales"}});

        const activated = await deliver(NotificationEventCodes.ACCOUNT_ACTIVATED, {variant: "invitation"});
        expect(activated).toMatchObject({params: {variant: "invitation"}});
    });
});

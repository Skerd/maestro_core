import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {Types} from "mongoose";

const mocks = vi.hoisted(() => ({push: vi.fn(), sms: vi.fn(), telegram: vi.fn()}));
// Nothing is sent: the WebSocket push, SMS/WhatsApp and Telegram are recorded.
vi.mock("@coreModule/connections/pushNotificationToUsers", () => ({pushNotificationToUsers: mocks.push}));
vi.mock("@coreModule/utilities/messaging/messagingDispatchService", () => ({sendMessagingNotification: mocks.sms}));
vi.mock("@coreModule/utilities/messaging/telegramDispatchService", () => ({sendTelegramNotification: mocks.telegram}));

import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {CONSTANTS} from "@coreModule/environment";
import User from "@coreModule/database/schemas/user/user";
import {createAndPushNotification} from "@coreModule/domain/notifications/notificationDomainService";
import {notificationText, receiverLanguage} from "@coreModule/domain/notifications/notificationTexts";
import {NotificationDeliveryChannel} from "armonia/src/modules/core/api/user/private/notifications/notifications.enum";

const companyId = new Types.ObjectId();
const swiss = new Types.ObjectId();
const unset = new Types.ObjectId();

const member = (_id: Types.ObjectId, extra: Record<string, unknown>) => ({
    _id,
    username: `${_id.toString()}@test.local`,
    phoneNumber: "+41000000000",
    telegram: {chatId: 4242},
    companies: [companyId],
    roles: [{company: companyId, active: "active", roles: []}],
    ...extra,
});

beforeAll(async () => {
    await connectTestDatabase();
    await User.collection.insertMany([member(swiss, {preferredLanguage: "de-CH"}), member(unset, {})]);
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(() => {
    mocks.push.mockReset();
    mocks.sms.mockReset().mockResolvedValue(undefined);
    mocks.telegram.mockReset().mockResolvedValue(undefined);
});

describe("notificationText (D128)", () => {
    it("renders a code from the shared texts in the asked language, variant and params included", () => {
        expect(notificationText("ROLE_ASSIGNED", {assigner: "Ada", role: "Sales"}, "de-CH")).toBe("Ada hat Ihnen die Rolle zugewiesen: Sales");
        expect(notificationText("ACCOUNT_ACTIVATED", {variant: "invitation"}, "en-US")).toBe("Your account is now active. You can sign in.");
    });

    // TD-B177: SMS and Telegram showed the stored (English) name of a default role.
    it("names default roles in the asked language and keeps custom role names", () => {
        const params = {assigner: "Ada", role: "General Administrator, Night shift", roleSlugs: "acme:reserved:general_administrator,acme:night-shift"};
        expect(notificationText("ROLE_ASSIGNED", params, "de-CH")).toBe("Ada hat Ihnen die Rolle zugewiesen: Hauptadministrator, Night shift");
    });

    it("returns null for an unknown code, and for a message that needs values none were given", () => {
        expect(notificationText("NO_SUCH_CODE", {}, "de-CH")).toBeNull();
        expect(notificationText("ROLE_ASSIGNED", undefined, "de-CH")).toBeNull();
    });

    it("writes for the receiver's own language, else the instance default", () => {
        expect(receiverLanguage({preferredLanguage: "fr-FR"})).toBe("fr-FR");
        expect(receiverLanguage({})).toBe(CONSTANTS.DEFAULT_LANGUAGE ?? "en-US");
        expect(receiverLanguage(null)).toBe(CONSTANTS.DEFAULT_LANGUAGE ?? "en-US");
    });
});

const notify = (receiver: Types.ObjectId) =>
    withTenant(companyId, () => createAndPushNotification({
        receiver,
        company: companyId,
        code: "ROLE_ASSIGNED",
        description: "Ada assigned you the role: Sales",
        params: {assigner: "Ada", role: "Sales"},
        channels: [NotificationDeliveryChannel.SMS],
    }));

// TD-B173: SMS, WhatsApp and Telegram sent the English description whatever the receiver's language.
describe("SMS and Telegram in the receiver's language (D128)", {timeout: 60000}, () => {
    it("sends the code's text in the receiver's preferred language", async () => {
        await notify(swiss);

        const body = "Ada hat Ihnen die Rolle zugewiesen: Sales";
        expect(mocks.sms).toHaveBeenCalledWith(expect.objectContaining({to: "+41000000000", body, channel: "sms"}));
        expect(mocks.telegram).toHaveBeenCalledWith({chatId: 4242, body});
    });

    it("uses the instance default for a receiver who never picked a language", async () => {
        await notify(unset);

        const body = notificationText("ROLE_ASSIGNED", {assigner: "Ada", role: "Sales"}, CONSTANTS.DEFAULT_LANGUAGE ?? "en-US");
        expect(mocks.sms).toHaveBeenCalledWith(expect.objectContaining({body}));
        expect(mocks.telegram).toHaveBeenCalledWith({chatId: 4242, body});
    });

    it("falls back to the stored English description for a code no module declares", async () => {
        await withTenant(companyId, () => createAndPushNotification({
            receiver: swiss,
            company: companyId,
            code: "WIDGET_APPROVED",
            description: "Widget approved",
        }));

        expect(mocks.sms).not.toHaveBeenCalled();
        expect(mocks.telegram).toHaveBeenCalledWith({chatId: 4242, body: "Widget approved"});
    });
});

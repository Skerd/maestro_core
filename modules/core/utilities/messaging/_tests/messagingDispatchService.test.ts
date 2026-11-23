import {beforeEach, describe, expect, it, vi} from "vitest";

// No Twilio and no database: the HTTP call is a fake, the platform's provider and each company's flag are stubs.
const ids = vi.hoisted(() => ({PLATFORM: "6512f0a1b2c3d4e5f6a7b800", COMPANY: "6512f0a1b2c3d4e5f6a7b8c9", SANDBOX: "6512f0a1b2c3d4e5f6a7b8aa"}));
const mocks = vi.hoisted(() => ({post: vi.fn()}));

vi.mock("axios", () => ({default: {post: mocks.post, isAxiosError: () => false}}));
vi.mock("@coreModule/utilities/security/platformAccess", async () => {
    const {ObjectId} = await import("mongodb");
    return {findPlatformCompanyId: vi.fn(async () => new ObjectId(ids.PLATFORM))};
});
vi.mock("@coreModule/database/schemas/messagingProvider/messagingProvider.service", () => ({
    messagingProviderService: {findOne: vi.fn(async () => ({accountSid: "AC-test", authTokenEncrypted: "sealed", fromPhone: "+41790000000"}))},
}));
vi.mock("@coreModule/utilities/security/encryption", () => ({DecryptString: () => "token", EncryptString: (value: string) => value}));
// SANDBOX is a sample company (D178); every other company is a real one.
vi.mock("@coreModule/database/schemas/company/company.service", () => ({
    companyService: {findById: vi.fn(async (id: unknown) => ({isSandbox: String(id) === ids.SANDBOX}))},
}));

import {sendMessagingNotification} from "../messagingDispatchService";

beforeEach(() => {
    mocks.post.mockReset();
    mocks.post.mockResolvedValue({data: {sid: "SM-1", status: "queued"}});
});

describe("a sample company sends no SMS (D178)", () => {
    it("texts nobody for a sample company, and still texts for a real one", async () => {
        await expect(sendMessagingNotification({to: "+355691130101", body: "See you tomorrow", channel: "sms", companyId: ids.SANDBOX}))
            .resolves.toBeNull();
        await expect(sendMessagingNotification({to: "+355691130101", body: "See you tomorrow", channel: "whatsapp", companyId: ids.SANDBOX}))
            .resolves.toBeNull();
        expect(mocks.post).not.toHaveBeenCalled();

        await expect(sendMessagingNotification({to: "+355691130101", body: "See you tomorrow", channel: "sms", companyId: ids.COMPANY}))
            .resolves.toEqual({sid: "SM-1", status: "queued"});
        expect(mocks.post).toHaveBeenCalledTimes(1);
    });
});

import {beforeEach, describe, expect, it, vi} from "vitest";

// No real SMTP or database: nodemailer is replaced by a fake transport, each company's servers by a stub list, and the
// platform company and company names by fixed values.
const ids = vi.hoisted(() => ({PLATFORM: "6512f0a1b2c3d4e5f6a7b800", COMPANY: "6512f0a1b2c3d4e5f6a7b8c9"}));
const mocks = vi.hoisted(() => ({
    email: {ENABLED: true, SMTP_HOST: "smtp.env.test", SMTP_PORT: 587, SMTP_SECURE: false, FROM_EMAIL: "env@example.com", FROM_NAME: "Env"},
    serversByCompany: {} as Record<string, Array<Record<string, unknown>>>,
    createTransport: vi.fn(),
}));

vi.mock("nodemailer", () => ({default: {createTransport: mocks.createTransport}}));
vi.mock("@coreModule/environment", () => ({
    EMAIL: mocks.email,
    SERVER: {NODE_ENV: "test"},
    ENCRYPTION_KEY: "x".repeat(64),
}));
vi.mock("@coreModule/database/schemas/smtpServer/smtpServer.service", () => ({
    smtpServerService: {findActiveInSequence: vi.fn(async (companyId: unknown) => mocks.serversByCompany[String(companyId)] ?? [])},
}));
vi.mock("@coreModule/utilities/security/platformAccess", async () => {
    const {ObjectId} = await import("mongodb");
    return {findPlatformCompanyId: vi.fn(async () => new ObjectId(ids.PLATFORM))};
});
vi.mock("@coreModule/database/schemas/company/company.service", () => ({
    companyService: {findById: vi.fn(async () => ({name: "Kudoo Market", email: "hello@market.test"}))},
}));

import {invalidateCompanyMailCache, sendMail} from "../mailDeliveryService";

const {PLATFORM, COMPANY} = ids;

function fakeTransport(messageId: string, fail = false) {
    return {
        verify: vi.fn(async () => true),
        sendMail: vi.fn(async (_mail: Record<string, unknown>) => {
            if (fail) throw new Error("connection refused");
            return {messageId};
        }),
    };
}

function smtpServer(id: string, sequence: number, fromEmail = "noreply@platform.test", fromName = "Kudoo") {
    return {_id: id, sequence, host: `smtp${sequence}.test`, port: 587, encryption: "starttls", authType: "none", fromEmail, fromName};
}

beforeEach(() => {
    mocks.email.ENABLED = true;
    mocks.serversByCompany = {};
    mocks.createTransport.mockReset();
    invalidateCompanyMailCache();
});

describe("sendMail returns the transport's message id (TD-B126)", () => {
    it("returns the id of the platform server that sent the mail", async () => {
        mocks.serversByCompany[PLATFORM] = [smtpServer("s1", 1)];
        mocks.createTransport.mockReturnValueOnce(fakeTransport("<abc@smtp1.test>"));

        await expect(sendMail(COMPANY, {to: "a@example.com", subject: "Hi", text: "Hello"}))
            .resolves.toEqual({messageId: "<abc@smtp1.test>"});
    });

    it("returns the id of the next server when the first one fails", async () => {
        mocks.serversByCompany[PLATFORM] = [smtpServer("s1", 1), smtpServer("s2", 2)];
        mocks.createTransport
            .mockReturnValueOnce(fakeTransport("<never@smtp1.test>", true))
            .mockReturnValueOnce(fakeTransport("<ok@smtp2.test>"));

        await expect(sendMail(COMPANY, {to: "a@example.com", subject: "Hi"}))
            .resolves.toEqual({messageId: "<ok@smtp2.test>"});
    });

    it("returns the env fallback's id when the platform has no server, and without a company", async () => {
        mocks.createTransport.mockReturnValue(fakeTransport("<env@smtp.env.test>"));

        await expect(sendMail(COMPANY, {to: "a@example.com", subject: "Hi"}))
            .resolves.toEqual({messageId: "<env@smtp.env.test>"});
        await expect(sendMail(null, {to: "a@example.com", subject: "Hi"}))
            .resolves.toEqual({messageId: "<env@smtp.env.test>"});
    });

    it("returns no id and sends nothing when email is turned off", async () => {
        mocks.email.ENABLED = false;

        await expect(sendMail(COMPANY, {to: "a@example.com", subject: "Hi"})).resolves.toEqual({});
        expect(mocks.createTransport).not.toHaveBeenCalled();
    });
});

describe("whose servers send a company's mail, and as whom (D161)", () => {
    it("sends a company's mail through the platform's servers, under the company's name, answered to the company", async () => {
        mocks.serversByCompany[PLATFORM] = [smtpServer("p1", 1)];
        mocks.serversByCompany[COMPANY] = [smtpServer("c1", 1, "own@market.test", "Market")];
        const transport = fakeTransport("<sent@platform>");
        mocks.createTransport.mockReturnValueOnce(transport);

        await sendMail(COMPANY, {to: "buyer@example.com", subject: "Your order"});

        expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
            from: expect.stringMatching(/Kudoo Market.*<noreply@platform\.test>/),
            replyTo: "hello@market.test",
        }));
    });

    it("keeps the platform's own mail as its servers write it", async () => {
        mocks.serversByCompany[PLATFORM] = [smtpServer("p1", 1)];
        const transport = fakeTransport("<sent@platform>");
        mocks.createTransport.mockReturnValueOnce(transport);

        await sendMail(PLATFORM, {to: "a@example.com", subject: "Hi"});

        const [mail] = transport.sendMail.mock.calls[0];
        expect(mail.from).toMatch(/Kudoo.*<noreply@platform\.test>/);
        expect(mail.from).not.toMatch(/Market/);
    });

    it("sends an own-servers message (a module's campaign) through the company's servers, and through the platform's when it has none", async () => {
        mocks.serversByCompany[PLATFORM] = [smtpServer("p1", 1)];
        mocks.serversByCompany[COMPANY] = [smtpServer("c1", 1, "own@market.test", "Market")];
        const own = fakeTransport("<sent@own>");
        mocks.createTransport.mockReturnValueOnce(own);

        await sendMail(COMPANY, {to: "lead@example.com", subject: "Hello"}, {ownServers: true});
        expect(own.sendMail.mock.calls[0][0].from).toMatch(/<own@market\.test>/);

        mocks.serversByCompany[COMPANY] = [];
        invalidateCompanyMailCache();
        const platform = fakeTransport("<sent@platform>");
        mocks.createTransport.mockReturnValueOnce(platform);

        await sendMail(COMPANY, {to: "lead@example.com", subject: "Hello", fromName: "Campaign Co", fromEmail: "team@campaign.test"}, {ownServers: true});
        expect(platform.sendMail).toHaveBeenCalledWith(expect.objectContaining({
            from: expect.stringMatching(/Campaign Co.*<noreply@platform\.test>/),
            replyTo: "team@campaign.test",
        }));
    });
});

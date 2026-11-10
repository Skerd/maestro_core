import {beforeEach, describe, expect, it, vi} from "vitest";

// No real SMTP: nodemailer is replaced by a fake transport, and the company's servers by a stub list.
const mocks = vi.hoisted(() => ({
    email: {ENABLED: true, SMTP_HOST: "smtp.env.test", SMTP_PORT: 587, SMTP_SECURE: false, FROM_EMAIL: "env@example.com", FROM_NAME: "Env"},
    servers: [] as Array<Record<string, unknown>>,
    createTransport: vi.fn(),
}));

vi.mock("nodemailer", () => ({default: {createTransport: mocks.createTransport}}));
vi.mock("@coreModule/environment", () => ({
    EMAIL: mocks.email,
    SERVER: {NODE_ENV: "test"},
    ENCRYPTION_KEY: "x".repeat(64),
}));
vi.mock("@coreModule/database/schemas/smtpServer/smtpServer.service", () => ({
    smtpServerService: {findActiveInSequence: vi.fn(async () => mocks.servers)},
}));

import {invalidateCompanyMailCache, sendMail} from "../mailDeliveryService";

const COMPANY = "6512f0a1b2c3d4e5f6a7b8c9";

function fakeTransport(messageId: string, fail = false) {
    return {
        verify: vi.fn(async () => true),
        sendMail: vi.fn(async () => {
            if (fail) throw new Error("connection refused");
            return {messageId};
        }),
    };
}

function smtpServer(id: string, sequence: number) {
    return {_id: id, sequence, host: `smtp${sequence}.test`, port: 587, encryption: "starttls", authType: "none", fromEmail: "co@example.com"};
}

describe("sendMail returns the transport's message id (TD-B126)", () => {
    beforeEach(() => {
        mocks.email.ENABLED = true;
        mocks.servers = [];
        mocks.createTransport.mockReset();
        invalidateCompanyMailCache();
    });

    it("returns the id of the company server that sent the mail", async () => {
        mocks.servers = [smtpServer("s1", 1)];
        mocks.createTransport.mockReturnValueOnce(fakeTransport("<abc@smtp1.test>"));

        await expect(sendMail(COMPANY, {to: "a@example.com", subject: "Hi", text: "Hello"}))
            .resolves.toEqual({messageId: "<abc@smtp1.test>"});
    });

    it("returns the id of the next server when the first one fails", async () => {
        mocks.servers = [smtpServer("s1", 1), smtpServer("s2", 2)];
        mocks.createTransport
            .mockReturnValueOnce(fakeTransport("<never@smtp1.test>", true))
            .mockReturnValueOnce(fakeTransport("<ok@smtp2.test>"));

        await expect(sendMail(COMPANY, {to: "a@example.com", subject: "Hi"}))
            .resolves.toEqual({messageId: "<ok@smtp2.test>"});
    });

    it("returns the env fallback's id when the company has no server, and without a company", async () => {
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

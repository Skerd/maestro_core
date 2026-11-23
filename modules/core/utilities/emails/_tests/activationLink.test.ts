/**
 * P23.12: someone who starts signing up from a page of the portal (a new business, a booking) gets an activation link
 * that brings them back there after their first sign-in: the link carries the page as `?next=`. The panel's link does
 * not, and without a `next` the link is as before.
 */
import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("@coreModule/environment", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@coreModule/environment")>();
    const urls: Record<string, string> = {portal: "http://portal.localhost:5212", public: "http://localhost:5210", core: "http://localhost:5211"};
    return {
        ...actual,
        EMAIL: {...actual.EMAIL, ENABLED: true},
        clientHostFor: (appId = "core") => urls[appId] ?? urls.core,
    };
});
const {sent} = vi.hoisted(() => ({sent: [] as string[]}));
vi.mock("@coreModule/utilities/emails/mailDeliveryService", () => ({
    sendMail: async (_companyId: unknown, options: {html: string}) => {
        sent.push(options.html);
    },
}));

import {sendSignUpMail} from "@coreModule/utilities/emails/notifiers";

const linkIn = (html: string) => html.match(/https?:\/\/[^"'\s<>]*\/(?:activate|authenticate\/activateAccount)\/CODE[^"'\s<>]*/)?.[0];

beforeEach(() => {
    sent.length = 0;
});

describe("the activation link (P23.12)", () => {
    it("brings a portal sign-up back to the page it started on", async () => {
        await sendSignUpMail(undefined, "ann@example.com", "Ann", "CODE", "en-US", "portal.localhost:5212", "/business/new?type=carRental&ref=rental");

        expect(linkIn(sent[0])).toBe("http://portal.localhost:5212/activate/CODE?next=%2Fbusiness%2Fnew%3Ftype%3DcarRental%26ref%3Drental");
    });

    it("is the plain link without a page to return to", async () => {
        await sendSignUpMail(undefined, "ann@example.com", "Ann", "CODE", "en-US", "portal.localhost:5212");

        expect(linkIn(sent[0])).toBe("http://portal.localhost:5212/activate/CODE");
    });

    it("leaves it off the panel's link", async () => {
        await sendSignUpMail(undefined, "ann@example.com", "Ann", "CODE", "en-US", "localhost:5211", "/business/new");

        expect(linkIn(sent[0])).toBe("http://localhost:5211/authenticate/activateAccount/CODE");
    });
});

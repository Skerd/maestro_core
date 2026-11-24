/**
 * D187: an invite of someone who already has an account emails them that they were added, in the invitation's layout
 * with its own texts and a sign-in link. The invitation itself still links to its acceptance page.
 */
import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("@coreModule/environment", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@coreModule/environment")>();
    return {
        ...actual,
        EMAIL: {...actual.EMAIL, ENABLED: true},
        CLIENT_SIDE: {...actual.CLIENT_SIDE, NAME: "Arpeggio"},
        clientHostFor: () => "http://localhost:5211",
    };
});
const {sent} = vi.hoisted(() => ({sent: [] as {to: string; subject: string; html: string}[]}));
vi.mock("@coreModule/utilities/emails/mailDeliveryService", () => ({
    sendMail: async (_companyId: unknown, options: {to: string; subject: string; html: string}) => {
        sent.push(options);
    },
}));

import {sendAddedToCompanyMail, sendInvitationMail} from "@coreModule/utilities/emails/notifiers";

beforeEach(() => {
    sent.length = 0;
});

describe("the added-to-company email (D187)", () => {
    it("tells them in their language who added them, as what, and links to sign-in", async () => {
        await sendAddedToCompanyMail("c1", "ann@example.com", "Ann Lee", "See you Monday.", "Marco Rossi", "Vista", "Klient uebi", "sq-AL");

        const [mail] = sent;
        expect(mail.to).toBe("ann@example.com");
        expect(mail.subject).toBe("Marco Rossi ju shtoi në Vista");
        expect(mail.html).toContain("Marco Rossi ju ka shtuar në Vista në Arpeggio si Klient uebi.");
        expect(mail.html).toContain("See you Monday.");
        expect(mail.html).toContain('href="http://localhost:5211/authenticate/login"');
        expect(mail.html).not.toMatch(/\{[a-zA-Z]+\}/);
    });

    it("leaves the message box out without a message", async () => {
        await sendAddedToCompanyMail("c1", "ann@example.com", "Ann Lee", "  ", "Marco Rossi", "Vista", "Sales", "en-US");

        expect(sent[0].html).not.toContain("A message from Marco Rossi");
    });

    it("keeps the invitation's own texts and acceptance link", async () => {
        await sendInvitationMail("c1", "ann@example.com", "CODE", "Ann Lee", "", "Marco Rossi", "Vista", "en-US");

        expect(sent[0].subject).toBe("Marco Rossi invited you to Vista");
        expect(sent[0].html).toContain('href="http://localhost:5211/authenticate/acceptInvitation/CODE"');
        expect(sent[0].html).not.toMatch(/\{[a-zA-Z]+\}/);
    });
});

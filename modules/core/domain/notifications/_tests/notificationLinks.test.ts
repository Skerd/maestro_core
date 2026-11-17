import {describe, expect, it} from "vitest";
import {notificationLink} from "@coreModule/domain/notifications/notificationTexts";

// TD-F113: clicking a notification ("Order ORD-… has been refunded") opened nothing. A notice to staff now opens its
// record's sheet on the panel list; one to a customer, who has no panel page for it, stays without a link.
describe("notification links", () => {
    it("opens the record a staff notice names, in every language", () => {
        for (const locale of ["en-US", "de-CH", "fr-FR", "it-IT", "sq-AL"]) {
            expect(notificationLink("PRODUCT_ORDER_NEW_MERCHANT", {orderId: "o1"}, locale)).toBe("/eCommerce/productorders?open=o1");
        }
        expect(notificationLink("VEHICLE_SERVICE_DUE", {vehicleId: "v1"}, "en-US")).toBe("/carRental/vehicles?open=v1");
        expect(notificationLink("VEHICLE_FINE_DUE", {vehicleId: "v1", recordId: "f1"}, "en-US")).toBe("/carRental/fines?open=f1");
        expect(notificationLink("INQUIRY_NEW", {inquiryId: "i1"}, "en-US")).toBe("/dentalClinic/inquiries?open=i1");
        expect(notificationLink("SALE_CREATED_STAFF", {saleId: "s1"}, "en-US")).toBe("/realEstate/sales?open=s1");
        // TD-B243: the SLA breach now goes to staff, so it opens the request.
        expect(notificationLink("MODIFICATION_REQUEST_SLA_BREACHED", {modificationRequestId: "m1"}, "en-US")).toBe("/realEstate/modificationRequests?open=m1");
        expect(notificationLink("PERMIT_EXPIRING", {permitId: "p1"}, "en-US")).toBe("/propertyDevelopment/permits?open=p1");
        expect(notificationLink("ORDER_CREATED_FROM_LISTING", {orderId: "m1"}, "en-US")).toBe("/marketplace/orders?open=m1");
        expect(notificationLink("PUBLIC_CHAT_HANDOFF_REQUESTED", {channelId: "c1"}, "en-US")).toBe("/company/websiteChats/waiting?channelId=c1");
    });

    it("opens a mixed notice's record only from the staff copy, and a mention in the team chat (TD-F133)", () => {
        expect(notificationLink("SALE_APPROVED", {saleId: "s1", staffSaleId: "s1"}, "en-US")).toBe("/realEstate/sales?open=s1");
        expect(notificationLink("SALE_APPROVED", {saleId: "s1"}, "en-US")).toBeNull();
        expect(notificationLink("DISPUTE_OPENED", {disputeId: "d1", providerDisputeId: "d1"}, "en-US")).toBe("/marketplace/disputes?open=d1");
        expect(notificationLink("ORDER_CANCELLED", {orderId: "o1"}, "en-US")).toBeNull();
        expect(notificationLink("MESSAGE_MENTIONED", {channelId: "c1"}, "en-US")).toBe("/company/chats?channelId=c1");
    });

    it("opens an account notice's tab only when the handler found the receiver can open it (TD-F133)", () => {
        expect(notificationLink("USER_LOGGED_IN_NEW_DEVICE", {accountTab: "security"}, "sq-AL")).toBe("/account/security");
        expect(notificationLink("TELEGRAM_UNLINKED", {accountTab: "apps"}, "en-US")).toBe("/account/apps");
        expect(notificationLink("MFA_DISABLED", {}, "en-US")).toBeNull();
    });

    it("gives a customer's notice no panel link", () => {
        expect(notificationLink("PRODUCT_ORDER_REFUNDED", {orderId: "o1"}, "en-US")).toBeNull();
        expect(notificationLink("PRODUCT_ORDER_SHIPPED", {orderId: "o1"}, "en-US")).toBeNull();
    });
});

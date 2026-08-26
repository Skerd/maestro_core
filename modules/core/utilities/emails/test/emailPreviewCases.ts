import type {ReservationClientEmailEvent, SaleClientEmailEvent} from "@propertyManagement/kafka/types";
import type {ManagerPinResetEmailEvent, ProductOrderClientEmailEvent} from "@eCommerceModule/kafka/types";

/**
 * Sample payloads for the preview renderer. They are deliberately "full" — every
 * optional field a template can show is populated, so a preview reveals layout
 * problems that a minimal payload would hide.
 */

export type PreviewModule = "core" | "propertyManagement" | "eCommerce";

export type PreviewCase = {
    /** Becomes the image filename: `<module>-<name>-<locale>.png`. */
    name: string;
    module: PreviewModule;
    /** Invokes the real notifier; the harness captures what it hands to `sendMail`. */
    send: (languageCode: string) => Promise<void>;
};

const EMAIL = "client@example.com";
const COMPANY_ID = "6512f0a1b2c3d4e5f6a7b8c9";
const COMPANY_NAME = "Vista Residences";
const FULL_NAME = "Ana Marku";
const USER_ID = "6512f0a1b2c3d4e5f6a7b8d0";

/** Dates are pre-formatted by the producer, so previews use display strings. */
const END_DATE = "14.09.2026";
const DUE_DATE = "05.10.2026";

function reservationEvent(overrides: Partial<ReservationClientEmailEvent>): ReservationClientEmailEvent {
    return {
        eventType: "reservation_client_email",
        email: EMAIL,
        userId: USER_ID,
        fullName: FULL_NAME,
        languageCode: "en-US",
        timestamp: Date.now(),
        kind: "created",
        companyId: COMPANY_ID,
        companyName: COMPANY_NAME,
        reservationId: "6512f0a1b2c3d4e5f6a7b8e1",
        reservationCode: "RES-2026-0184",
        unitNumber: "B-704",
        unitDisplayName: "Panorama Duplex",
        projectName: "Lakeview Residences",
        edificeName: "Tower B",
        floorName: "7th floor",
        unitPriceDisplay: "CHF 248'000.00",
        reservationDepositDisplay: "CHF 5'000.00",
        expirationDateFormatted: END_DATE,
        expirationDateIso: "2026-09-14T00:00:00.000Z",
        ...overrides,
    };
}

function saleEvent(overrides: Partial<SaleClientEmailEvent>): SaleClientEmailEvent {
    return {
        eventType: "sale_client_email",
        email: EMAIL,
        userId: USER_ID,
        fullName: FULL_NAME,
        languageCode: "en-US",
        timestamp: Date.now(),
        kind: "sale_created",
        companyId: COMPANY_ID,
        companyName: COMPANY_NAME,
        saleId: "6512f0a1b2c3d4e5f6a7b8f2",
        saleCode: "SL-2026-0093",
        paymentType: "payment_plan",
        unitNumber: "B-704",
        unitDisplayName: "Panorama Duplex",
        projectName: "Lakeview Residences",
        edificeName: "Tower B",
        floorName: "7th floor",
        unitPriceDisplay: "CHF 248'000.00",
        finalPriceDisplay: "CHF 241'500.00",
        downPaymentDisplay: "CHF 48'300.00",
        numberOfInstallments: 24,
        installmentNumber: 4,
        installmentAmountDisplay: "CHF 8'050.00",
        installmentDueDateFormatted: DUE_DATE,
        installmentDueDateIso: "2026-10-05T00:00:00.000Z",
        ...overrides,
    };
}

function orderEvent(overrides: Partial<ProductOrderClientEmailEvent>): ProductOrderClientEmailEvent {
    return {
        eventType: "product_order_client_email",
        email: EMAIL,
        userId: USER_ID,
        fullName: FULL_NAME,
        languageCode: "en-US",
        timestamp: Date.now(),
        kind: "placed",
        companyId: COMPANY_ID,
        companyName: "Aurora Store",
        orderId: "6512f0a1b2c3d4e5f6a7c001",
        orderNumber: "ORD-2026-004512",
        orderTotalDisplay: "CHF 189.90",
        trackingNumber: "CH938174652",
        trackingUrl: "https://track.example.com/CH938174652",
        carrier: "Swiss Post",
        refundAmountDisplay: "CHF 49.90",
        failureReason: "The card issuer declined the payment.",
        itemCount: 3,
        giftCardCodes: ["GC-4H8P-2XQA", "GC-9KLM-7TRB"],
        downloadLinks: [{productTitle: "Focus — Album (FLAC)", url: "https://files.example.com/d/8f2a1c"}],
        productTitle: "Studio Monitor Stand",
        warehouseName: "Zurich Central",
        availableQuantity: 2,
        reorderPoint: 10,
        ...overrides,
    };
}

function pinResetEvent(languageCode: string): ManagerPinResetEmailEvent {
    return {
        eventType: "manager_pin_reset_email",
        email: EMAIL,
        userId: USER_ID,
        fullName: FULL_NAME,
        configId: "6512f0a1b2c3d4e5f6a7c100",
        configName: "Aurora Store — Till 2",
        resetCode: "b7f1c2d3e4a5",
        languageCode,
        timestamp: Date.now(),
        companyId: COMPANY_ID,
    };
}

/**
 * Built lazily: the notifier modules must not load until the harness has stubbed
 * mail delivery, so `require` them inside the case rather than importing above.
 */
export function buildPreviewCases(): PreviewCase[] {
    const core = () => require("@coreModule/utilities/emails/notifiers");
    const reservation = () => require("@propertyManagement/utilities/emails/notifiers");
    const sale = () => require("@propertyManagement/utilities/emails/saleNotifiers");
    const order = () => require("@eCommerceModule/utilities/emails/sendProductOrderClientMail");
    const pin = () => require("@eCommerceModule/utilities/emails/sendManagerPinResetMail");

    const cases: PreviewCase[] = [
        {
            name: "activateAccount",
            module: "core",
            send: (lang) => core().sendSignUpMail(COMPANY_ID, EMAIL, FULL_NAME, "a1b2c3d4e5f6", lang),
        },
        {
            name: "forgotPassword-24h",
            module: "core",
            send: (lang) => core().sendForgetPasswordMail(COMPANY_ID, EMAIL, "a1b2c3d4e5f6", FULL_NAME, false, lang),
        },
        {
            name: "forgotPassword-single-use",
            module: "core",
            send: (lang) => core().sendForgetPasswordMail(COMPANY_ID, EMAIL, "a1b2c3d4e5f6", FULL_NAME, true, lang),
        },
        {
            name: "deactivateOtp",
            module: "core",
            send: (lang) => core().sendMfaDeactivationMail(COMPANY_ID, EMAIL, "a1b2c3d4e5f6", FULL_NAME, lang),
        },
        {
            name: "invitation",
            module: "core",
            send: (lang) =>
                core().sendInvitationMail(COMPANY_ID, EMAIL, "a1b2c3d4e5f6", FULL_NAME, "", "Marco Rossi", COMPANY_NAME, lang),
        },
        {
            name: "invitation-with-message",
            module: "core",
            send: (lang) =>
                core().sendInvitationMail(
                    COMPANY_ID,
                    EMAIL,
                    "a1b2c3d4e5f6",
                    FULL_NAME,
                    "Welcome aboard — ping me once you are in and I will walk you through the unit handover flow.",
                    "Marco Rossi",
                    COMPANY_NAME,
                    lang
                ),
        },
    ];

    const reservationKinds: [string, Partial<ReservationClientEmailEvent>][] = [
        ["created", {kind: "created", reservationContractMediaId: "6512f0a1b2c3d4e5f6a7b900"}],
        ["created-no-contract", {kind: "created"}],
        ["paid", {kind: "paid"}],
        ["expired", {kind: "expiration_expired"}],
        ["remaining-days", {kind: "remaining_days", daysRemaining: 4}],
        ["reminder-3", {kind: "expiration_reminder", reminderPhase: "3"}],
        ["reminder-1", {kind: "expiration_reminder", reminderPhase: "1"}],
        ["reminder-0", {kind: "expiration_reminder", reminderPhase: "0"}],
    ];
    for (const [name, overrides] of reservationKinds) {
        cases.push({
            name: `reservation-${name}`,
            module: "propertyManagement",
            send: (lang) => reservation().sendReservationClientMail(reservationEvent({...overrides, languageCode: lang})),
        });
    }

    const saleKinds: [string, Partial<SaleClientEmailEvent>][] = [
        ["created", {kind: "sale_created", purchaseContractMediaId: "6512f0a1b2c3d4e5f6a7b901"}],
        ["created-cash", {kind: "sale_created", paymentType: "cash", downPaymentDisplay: undefined, numberOfInstallments: undefined}],
        ["installment-remaining-days", {kind: "installment_remaining_days", daysRemaining: 6}],
        ["installment-overdue", {kind: "installment_overdue"}],
        ["installment-reminder-3", {kind: "installment_reminder", reminderPhase: "3"}],
        ["installment-reminder-1", {kind: "installment_reminder", reminderPhase: "1"}],
        ["installment-reminder-0", {kind: "installment_reminder", reminderPhase: "0"}],
    ];
    for (const [name, overrides] of saleKinds) {
        cases.push({
            name: `sale-${name}`,
            module: "propertyManagement",
            send: (lang) => sale().sendSaleClientMail(saleEvent({...overrides, languageCode: lang})),
        });
    }

    const orderKinds: ProductOrderClientEmailEvent["kind"][] = [
        "placed", "paid", "payment_failed", "confirmed", "shipped", "delivered", "cancelled",
        "refunded", "abandoned_cart", "gift_card_issued", "digital_delivery_ready",
        "return_approved", "return_rejected", "new_order_merchant", "low_stock",
    ];
    for (const kind of orderKinds) {
        cases.push({
            name: `order-${kind.replace(/_/g, "-")}`,
            module: "eCommerce",
            send: (lang) => order().sendProductOrderClientMail(orderEvent({kind, languageCode: lang})),
        });
    }

    cases.push({
        name: "managerPinReset",
        module: "eCommerce",
        send: (lang) => pin().sendManagerPinResetMail(pinResetEvent(lang)),
    });

    return cases;
}

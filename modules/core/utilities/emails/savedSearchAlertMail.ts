import * as fs from "fs";
import * as path from "path";
import type {ObjectId} from "mongodb";
import type {PortalCatalogItem} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";
import {CLIENT_SIDE, EMAIL} from "@coreModule/environment";
import {applyPlaceholders, loadEmailStrings, type EmailStrings} from "@coreModule/utilities/emails/emailLocale";
import {currentYear, EMAIL_FONT, escapeHtml, layoutStrings, localized, summaryCardHtml} from "@coreModule/utilities/emails/emailLayout";
import {sendMail} from "@coreModule/utilities/emails/mailDeliveryService";
import {publishSavedSearchAlertEmailEvent} from "@coreModule/kafka/kafkaProducer";
import type {SavedSearchAlertEmailEvent} from "@coreModule/kafka/types";
import type {serverLogger} from "@coreModule/loggers/serverLog";

const TEMPLATE_DIR = path.join(__dirname, "templates", "savedSearchAlert");

/** One saved search's block in the digest: its words, what is new and where to see it all or stop it. */
export type SavedSearchAlertBlock = {
    label: string;
    /** The newest items, a few per kind. */
    items: PortalCatalogItem[];
    /** How many are new in all. */
    total: number;
    resultsUrl: string;
    stopUrl: string;
};

/** One person's daily email (D178, P23.7): every saved search of theirs with something new. */
export type SavedSearchDigest = {
    email: string;
    fullName: string;
    languageCode: string;
    blocks: SavedSearchAlertBlock[];
};

function readTemplate(filename: string): string {
    return fs.readFileSync(path.join(TEMPLATE_DIR, filename), "utf8");
}

/** A card's price as words, like the portal's cards: "€60 / day", "from €60", "up to €200". */
function priceLabel(price: PortalCatalogItem["price"], strings: EmailStrings, languageCode: string): string {
    if (!price) return "";
    let amount: string;
    try {
        amount = new Intl.NumberFormat(languageCode, {
            style: "currency",
            currency: price.currency,
            ...(Number.isInteger(price.amount) ? {maximumFractionDigits: 0} : {}),
        }).format(price.amount);
    } catch {
        amount = `${price.amount} ${price.currency}`;
    }
    if (price.per === "day") return localized(strings, "pricePerDay", {price: amount});
    if (price.from) return localized(strings, "priceFrom", {price: amount});
    if (price.upTo) return localized(strings, "priceUpTo", {price: amount});
    return amount;
}

/** "and 4 more" under a search's card, when it holds more new items than the card shows. */
function moreHtml(text: string): string {
    return `<p style="margin:12px 0 0;font-family:${EMAIL_FONT};font-size:13px;font-weight:400;line-height:170%;color:#8a9099;">${escapeHtml(text)}</p>`;
}

function blockHtml(block: SavedSearchAlertBlock, strings: EmailStrings, languageCode: string): string {
    const rows = block.items.map((item) => ({
        label: [item.title, [item.company.name, item.city].filter(Boolean).join(", ")].join(" · "),
        value: priceLabel(item.price, strings, languageCode),
    }));
    const more = block.total - block.items.length;
    return applyPlaceholders(readTemplate("search.html"), {
        summary: summaryCardHtml(block.label, rows),
        more: more > 0 ? moreHtml(localized(strings, more === 1 ? "moreOne" : "more", {count: String(more)})) : "",
        resultsUrl: escapeHtml(block.resultsUrl),
        seeResults: escapeHtml(localized(strings, block.total === 1 ? "seeResultOne" : "seeResults", {count: String(block.total)})),
        stopUrl: escapeHtml(block.stopUrl),
        stop: escapeHtml(strings.stop ?? ""),
    });
}

/** The digest's subject and HTML, in the shell of the other client emails. */
export function buildSavedSearchAlertMail(digest: SavedSearchDigest): {subject: string; html: string} {
    const strings = loadEmailStrings(["savedSearchAlert"], digest.languageCode);
    const pageName = CLIENT_SIDE.NAME ?? "";
    const total = digest.blocks.reduce((sum, block) => sum + block.total, 0);
    const bodyInner = applyPlaceholders(readTemplate("body.html"), {
        intro: escapeHtml(strings.intro ?? ""),
        blocks: digest.blocks.map((block) => blockHtml(block, strings, digest.languageCode)).join(""),
    });
    let html = applyPlaceholders(readTemplate("savedSearchAlert.html"), layoutStrings(strings, "heading", "preheader"));
    html = applyPlaceholders(html, {
        greeting: localized(strings, "greeting", {fullName: escapeHtml(digest.fullName)}),
        bodyInner,
        pageName: escapeHtml(pageName),
        year: currentYear(),
    });
    const subject = localized(strings, total === 1 ? "subjectOne" : "subject", {count: String(total), pageName});
    return {subject, html};
}

/**
 * Sends the digest from the platform company. Does nothing when email is off (dev); a failed send throws, so the
 * alert job keeps the person's searches for the next run.
 */
export async function sendSavedSearchAlertMail(platformId: ObjectId, digest: SavedSearchDigest): Promise<void> {
    if (!EMAIL.ENABLED) return;
    const {subject, html} = buildSavedSearchAlertMail(digest);
    await sendMail(platformId, {to: digest.email, subject, html});
}

/**
 * Hands the digest to Kafka, so it survives a restart and is retried (D188); sends it directly when Kafka is off or the
 * publish fails. A direct send that fails throws, so the job keeps the searches for the next run.
 */
export async function dispatchSavedSearchAlertEmail(platformId: ObjectId, digest: SavedSearchDigest, logger?: serverLogger): Promise<void> {
    const event: SavedSearchAlertEmailEvent = {...digest, eventType: "saved_search_alert_email", timestamp: Date.now(), companyId: platformId.toString()};
    if (!(await publishSavedSearchAlertEmailEvent(event, logger))) await sendSavedSearchAlertMail(platformId, digest);
}

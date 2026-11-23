/**
 * The portal app's own `index.html` with one page's head filled in (D181): title, description, canonical address,
 * share preview and structured data for everyone, and for crawlers a plain copy of the page inside the app's root, which
 * the app replaces as soon as it starts. Every value is escaped: names and titles come from businesses and visitors.
 *
 * @module portalPageHtml
 */

import type {PortalPage} from "./portalPage";

/** Link previews and search crawlers: they get the plain copy; people get the app at once, with no flash of it. */
const CRAWLER_AGENT = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|whatsapp|telegram|discord|pinterest|bingpreview/i;

export function isCrawler(userAgent: string | undefined): boolean {
    return CRAWLER_AGENT.test(userAgent ?? "");
}

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** JSON inside a `<script>`: `<` escaped so a value can never close the tag. */
function scriptJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, "\\u003c");
}

function headTags(page: PortalPage): string {
    const meta = (attribute: "name" | "property", key: string, content: string) =>
        `<meta ${attribute}="${key}" content="${escapeHtml(content)}" />`;
    return [
        `<title>${escapeHtml(page.title)}</title>`,
        meta("name", "description", page.description),
        `<link rel="canonical" href="${escapeHtml(page.canonical)}" />`,
        ...page.alternates.map((alternate) => `<link rel="alternate" hreflang="${escapeHtml(alternate.hreflang)}" href="${escapeHtml(alternate.href)}" />`),
        ...(page.indexable ? [] : [meta("name", "robots", "noindex")]),
        meta("property", "og:site_name", page.siteName),
        meta("property", "og:locale", page.language.replace("-", "_")),
        meta("property", "og:title", page.title),
        meta("property", "og:description", page.description),
        meta("property", "og:url", page.canonical),
        meta("property", "og:type", page.type),
        ...(page.image ? [meta("property", "og:image", page.image)] : []),
        meta("name", "twitter:card", page.image ? "summary_large_image" : "summary"),
        ...page.jsonLd.map((data) => `<script type="application/ld+json">${scriptJson(data)}</script>`),
    ].join("\n    ");
}

function plainCopy(page: PortalPage): string {
    const links = page.links.map((link) =>
        `<li><a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a>${link.detail ? ` ${escapeHtml(link.detail)}` : ""}</li>`);
    return [
        "<main data-portal-copy>",
        `<h1>${escapeHtml(page.heading)}</h1>`,
        ...(page.intro ? [`<p>${escapeHtml(page.intro)}</p>`] : []),
        ...(links.length > 0 ? [`<ul>${links.join("")}</ul>`] : []),
        "</main>",
    ].join("");
}

/** `template` (the app's `index.html`) carrying `page`'s head, and its plain copy when `withCopy`. */
export function renderPortalPage(template: string, page: PortalPage, withCopy: boolean): string {
    let html = template.replace(/<html([^>]*)\slang="[^"]*"/i, `<html$1 lang="${escapeHtml(page.language)}"`);
    const head = headTags(page);
    html = /<title>[\s\S]*?<\/title>/i.test(html)
        ? html.replace(/<title>[\s\S]*?<\/title>/i, () => head)
        : html.replace(/<\/head>/i, () => `    ${head}\n  </head>`);
    if (withCopy) html = html.replace(/<div id="root"><\/div>/i, () => `<div id="root">${plainCopy(page)}</div>`);
    return html;
}

/**
 * The portal zone (`PORTAL_ROOT_DOMAIN`): the apex (`arpeggio.al`, `www.arpeggio.al`) lists
 * every eligible company, and `{siteSlug}.{root}` is one company's own site. The whole zone
 * shares one platform session: accounts there belong to the platform owner.
 *
 * Reserved labels (`panel`, `api`, …) are not company sites, so the panel can live in the zone
 * (`panel.arpeggio.al`) and keep its own per-company sign-in.
 */

import {PORTAL_ROOT_DOMAIN} from "@coreModule/environment";
import {isReservedSiteSlug} from "armonia/src/modules/core/api/company/private/company/siteSlug";

/**
 * A developer's machine (`localhost`, `*.localhost`, loopback IPs). Only here may a public request that
 * matches no company fall back to a wildcard (`allowedDomains: "*"`) company (D18).
 */
export function isLocalDevOrigin(origin: string): boolean {
    const host = normalizeOriginHost(origin);
    return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
}

/** Normalize Origin / Referer / hostname to a bare lowercase host (no port). */
export function normalizeOriginHost(origin: string): string {
    return (origin || "")
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .split("/")[0]
        .split(":")[0]
        .trim();
}

/** True on the portal apex, which names no company: a page's company travels in `x-site-company`. */
export function isPortalApexOrigin(origin: string, root: string = PORTAL_ROOT_DOMAIN): boolean {
    if (!root) return false;
    const host = normalizeOriginHost(origin);
    return host === root || host === `www.${root}`;
}

/** The company a `{siteSlug}.{root}` host names (its slug, or its id), else null. */
export function portalSiteSlug(origin: string, root: string = PORTAL_ROOT_DOMAIN): string | null {
    if (!root) return null;
    const host = normalizeOriginHost(origin);
    if (!host.endsWith(`.${root}`)) return null;
    const label = host.slice(0, -root.length - 1);
    return label && !label.includes(".") && !isReservedSiteSlug(label) ? label : null;
}

/** True on the apex or a company site: anywhere the platform session applies. */
export function isPortalZoneOrigin(origin: string, root: string = PORTAL_ROOT_DOMAIN): boolean {
    return isPortalApexOrigin(origin, root) || portalSiteSlug(origin, root) !== null;
}

/**
 * Detects public requests that span every company rather than one company's site:
 * the shop apex (`SHOP_ROOT_DOMAIN` / `www.{SHOP_ROOT_DOMAIN}`) and the central portal
 * (`PORTAL_ROOT_DOMAIN`), as opposed to a per-company `{slug}.{root}` storefront.
 *
 * Local DX: bare `localhost` is always the platform apex when the root zone is
 * empty or is itself `localhost`, so `npm run publicDev` shows all sellers.
 * Tenant shops stay on `{slug}.localhost` (e.g. ecommerce.localhost).
 */

import {PORTAL_ROOT_DOMAIN, SHOP_ROOT_DOMAIN} from "@coreModule/environment";

/** Normalize Origin / Referer / hostname to a bare lowercase host (no port). */
export function normalizeShopOriginHost(origin: string): string {
    return (origin || "")
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .split("/")[0]
        .split(":")[0]
        .trim();
}

/**
 * True on the central portal (`PORTAL_ROOT_DOMAIN` / `www.{root}`). There the host names no
 * company: the page's company travels in the `x-site-company` header.
 */
export function isPortalOrigin(origin: string, root: string = PORTAL_ROOT_DOMAIN): boolean {
    if (!root) return false;
    const host = normalizeShopOriginHost(origin);
    return host === root || host === `www.${root}`;
}

/**
 * True when the request host is the configured shop root (apex), including `www.`, or the
 * portal, whose shop is the same all-sellers shop.
 * Bare `localhost` is platform when `SHOP_ROOT_DOMAIN` is empty or `localhost`.
 */
export function isPlatformShopOrigin(origin: string): boolean {
    if (isPortalOrigin(origin)) return true;
    const host = normalizeShopOriginHost(origin);
    const root = SHOP_ROOT_DOMAIN;

    if (!root || root === "localhost") {
        return host === "localhost";
    }

    return host === root || host === `www.${root}`;
}

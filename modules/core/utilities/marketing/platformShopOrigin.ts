/**
 * Detects whether a public shop request is on the platform apex host
 * (`SHOP_ROOT_DOMAIN` / `www.{SHOP_ROOT_DOMAIN}`) rather than a per-company
 * `{slug}.{root}` storefront.
 *
 * Local DX: bare `localhost` is always the platform apex when the root zone is
 * empty or is itself `localhost`, so `npm run publicDev` shows all sellers.
 * Tenant shops stay on `{slug}.localhost` (e.g. ecommerce.localhost).
 */

import {SHOP_ROOT_DOMAIN} from "@coreModule/environment";

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
 * True when the request host is the configured shop root (apex), including `www.`.
 * Bare `localhost` is platform when `SHOP_ROOT_DOMAIN` is empty or `localhost`.
 */
export function isPlatformShopOrigin(origin: string): boolean {
    const host = normalizeShopOriginHost(origin);
    const root = SHOP_ROOT_DOMAIN;

    if (!root || root === "localhost") {
        return host === "localhost";
    }

    return host === root || host === `www.${root}`;
}

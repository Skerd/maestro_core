/**
 * Registry of route prefixes that must retain the unparsed request body.
 *
 * Payment webhooks verify gateway signatures against the exact raw payload.
 * Route files opt in by exporting `needsRawBody = true` next to `basePath`;
 * {@link module:routeRegistry} registers the prefix at discovery time, and
 * the apiServer body-parser `verify` callback consults this set per request.
 *
 * @module rawBodyRouteRegistry
 */

const rawBodyPrefixes = new Set<string>();

/**
 * Register a route prefix whose requests should keep `req.rawBody`.
 * Idempotent for the same prefix.
 */
export function registerRawBodyPrefix(prefix: string): void {
    if (!prefix) return;
    rawBodyPrefixes.add(prefix);
}

/**
 * Whether the given request URL (typically `req.originalUrl`) matches a
 * registered raw-body prefix.
 */
export function shouldPreserveRawBody(url: string | undefined): boolean {
    if (!url) return false;
    // Strip query string — prefixes are path-only.
    const pathOnly = url.split("?")[0] ?? url;
    for (const prefix of rawBodyPrefixes) {
        if (pathOnly.startsWith(prefix)) {
            return true;
        }
    }
    return false;
}

/**
 * The platform pages of every module the server runs: the routers the platform company may use without running their
 * module, and the collections they serve. Two kinds register here:
 * - platform lists (D160, D195: product and service categories), which `createCrudRouter` records for
 *   `platformListRouteOptions`;
 * - a module's other work the platform company does for every company (D197: the marketplace's portal jobs, quotes,
 *   job settings and disputes), which the module records with {@link registerPlatformRouter} next to the router.
 * `authMW` lets the platform company through those routers and keeps those collections' permission tags, and only
 * those, from modules it does not have; the panel shows the module's `platformUrls` pages.
 *
 * @module platformListRegistry
 */

const routers = new WeakSet<object>();
const collections = new Set<string>();
const modules = new Set<string>();

/**
 * Records that the platform company may use `router`, which serves `collectionNames`, without running its module. The
 * router's handlers still decide what the platform company may do there.
 */
export function registerPlatformRouter(router: object, ...collectionNames: string[]): void {
    routers.add(router);
    for (const collectionName of collectionNames) collections.add(collectionName);
}

/** Whether the platform company may use `router` without its module. */
export function isPlatformRouter(router: object): boolean {
    return routers.has(router);
}

/** Whether `collectionName` is served by a platform router. */
export function isPlatformCollection(collectionName: string): boolean {
    return collections.has(collectionName);
}

/** The permission tag prefixes of every platform collection (`productcategories[`), for the platform company's access. */
export function platformTagPrefixes(): string[] {
    return [...collections].map((collection) => `${collection}[`);
}

/** Records that `moduleName` serves a platform router; the route registry calls it when it mounts one. */
export function recordPlatformModule(moduleName: string): void {
    modules.add(moduleName);
}

/** The modules that serve a platform router: the platform company's panel shows their platform pages (D195, D197). */
export function platformModules(): string[] {
    return [...modules];
}

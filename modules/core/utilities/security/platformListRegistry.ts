/**
 * The platform lists of every module the server runs (D160, D195): which routers serve one, and their collections.
 * The platform company manages a module's platform lists without running that module (D195: product categories while
 * the platform company has core only): `authMW` lets it through a platform list's routes and keeps those lists'
 * permission tags, and only those, from modules it does not have.
 *
 * @module platformListRegistry
 */

const routers = new WeakSet<object>();
const collections = new Set<string>();
const modules = new Set<string>();

/** Records that `router` serves the platform list `collectionName`; `createCrudRouter` calls it for `platformListRouteOptions`. */
export function registerPlatformListRouter(router: object, collectionName: string): void {
    routers.add(router);
    collections.add(collectionName);
}

/** Whether `router` serves a platform list. */
export function isPlatformListRouter(router: object): boolean {
    return routers.has(router);
}

/** Whether `collectionName` is a platform list. */
export function isPlatformListCollection(collectionName: string): boolean {
    return collections.has(collectionName);
}

/** The permission tag prefixes of every platform list (`productcategories[`), for the platform company's access. */
export function platformListTagPrefixes(): string[] {
    return [...collections].map((collection) => `${collection}[`);
}

/** Records that `moduleName` serves a platform list; the route registry calls it when it mounts one of its routers. */
export function recordPlatformListModule(moduleName: string): void {
    modules.add(moduleName);
}

/** The modules that serve a platform list: the platform company's panel shows their platform-list pages (D195). */
export function platformListModules(): string[] {
    return [...modules];
}

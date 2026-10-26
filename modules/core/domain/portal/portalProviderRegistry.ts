/**
 * Portal section registry. Modules register their section at startup (see
 * {@link module:registerAllPortalProviders}); the portal endpoints read them.
 *
 * @module portalProviderRegistry
 */

import type {PortalProvider} from "@coreModule/domain/portal/portalProvider.types";

const providers = new Map<string, PortalProvider>();

export function registerPortalProvider(provider: PortalProvider): void {
    providers.set(provider.key, provider);
}

export function getPortalProvider(key: string): PortalProvider | undefined {
    return providers.get(key);
}

/** Registered sections in display order. */
export function listPortalProviders(): PortalProvider[] {
    return [...providers.values()].sort((a, b) => a.order - b.order);
}

/** Clear the registry (tests only). */
export function clearPortalProviders(): void {
    providers.clear();
}

import type {ShopProvisionStatus} from "armonia/src/modules/core/api/company/private/company/shopSlug";

export type ShopProvisionSteps = {
    slug: boolean;
    domain: boolean;
    reachable: boolean;
};

export type ShopProvisionState = {
    status: ShopProvisionStatus;
    lastError?: string;
    steps: ShopProvisionSteps;
};

export type ShopHostAssignment = {
    shopSlug: string;
    shopHost?: string;
    allowedDomains: string[];
    shopProvision: ShopProvisionState;
};

function normalizeHost(value: string): string {
    return value.trim().toLowerCase();
}

export function shopHostForSlug(slug: string, rootDomain: string): string {
    return `${slug}.${rootDomain}`;
}

export function mergeShopAllowedDomains(
    domains: string[],
    nextHost: string | undefined,
    previousHost?: string,
): string[] {
    const previous = previousHost ? normalizeHost(previousHost) : "";
    const next = nextHost ? normalizeHost(nextHost) : "";
    const merged: string[] = [];
    for (const domain of domains) {
        const host = normalizeHost(domain);
        if (!host || host === previous || host === next) {
            continue;
        }
        merged.push(host);
    }
    if (next) {
        merged.push(next);
    }
    return merged;
}

export function buildShopHostAssignment(input: {
    shopSlug: string;
    allowedDomains: string[];
    rootDomain: string;
    previousHost?: string;
}): ShopHostAssignment {
    const rootDomain = input.rootDomain.trim().toLowerCase();
    if (!rootDomain) {
        return {
            shopSlug: input.shopSlug,
            allowedDomains: mergeShopAllowedDomains(input.allowedDomains, undefined, input.previousHost),
            shopProvision: {
                status: "failed",
                lastError: "SHOP_ROOT_DOMAIN is not set",
                steps: {slug: true, domain: false, reachable: false},
            },
        };
    }

    const shopHost = shopHostForSlug(input.shopSlug, rootDomain);
    return {
        shopSlug: input.shopSlug,
        shopHost,
        allowedDomains: mergeShopAllowedDomains(input.allowedDomains, shopHost, input.previousHost),
        shopProvision: {
            status: "pending",
            lastError: "",
            steps: {slug: true, domain: true, reachable: false},
        },
    };
}

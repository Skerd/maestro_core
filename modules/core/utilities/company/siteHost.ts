import type {SiteProvisionStatus} from "armonia/src/modules/core/api/company/private/company/siteSlug";

export type SiteProvisionSteps = {
    slug: boolean;
    domain: boolean;
    reachable: boolean;
};

export type SiteProvisionState = {
    status: SiteProvisionStatus;
    lastError?: string;
    steps: SiteProvisionSteps;
};

export type SiteHostAssignment = {
    siteSlug: string;
    siteHost?: string;
    siteProvision: SiteProvisionState;
};

export function siteHostForSlug(slug: string, rootDomain: string): string {
    return `${slug}.${rootDomain}`;
}

/**
 * The company's own site in the portal zone (`{siteSlug}.{root}`). The host is resolved from
 * the request origin, so it never goes into `allowedDomains` (those stay the company's own domains).
 */
export function buildSiteHostAssignment(input: {siteSlug: string; rootDomain: string}): SiteHostAssignment {
    const rootDomain = input.rootDomain.trim().toLowerCase();
    if (!rootDomain) {
        return {
            siteSlug: input.siteSlug,
            siteProvision: {
                status: "failed",
                lastError: "PORTAL_ROOT_DOMAIN is not set",
                steps: {slug: true, domain: false, reachable: false},
            },
        };
    }

    return {
        siteSlug: input.siteSlug,
        siteHost: siteHostForSlug(input.siteSlug, rootDomain),
        siteProvision: {
            status: "pending",
            lastError: "",
            steps: {slug: true, domain: true, reachable: false},
        },
    };
}

/**
 * A company's own domains (`Company.allowedDomains`), which only the platform sets (D189): public requests on a listed
 * host are served as that company (SEC-04), so a host belongs to one company. Hosts the platform itself serves are the
 * exception: any number of companies may list them (a self-serve business lists the panel host so its owner signs in
 * there, D178).
 *
 * @module utilities/company/companyDomains
 */

import type {ClientSession} from "mongoose";
import type {ObjectId} from "mongodb";
import {CLIENT_SIDE, PORTAL_ROOT_DOMAIN} from "@coreModule/environment";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {isLocalDevOrigin} from "@coreModule/utilities/marketing/portalOrigin";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {normalizeCompanyDomain} from "armonia/src/modules/core/api/company/private/company/companyDomain";

/** What a company is created with when it names no domain of its own. */
export const NO_COMPANY_DOMAIN = "none.none.com";

function hostOf(url: string | undefined): string | null {
    if (!url) return null;
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
}

/**
 * A host the platform serves itself: its panel and app addresses (`SINFONIA_CLIENT_URLS`, `CLIENT_HOST`), the portal
 * apex and every `{slug}.{root}` site, a local development host, and the placeholders `*` and `none.none.com`.
 */
export function isPlatformHost(host: string): boolean {
    if (host === "*" || host === NO_COMPANY_DOMAIN || isLocalDevOrigin(host)) return true;
    const root = PORTAL_ROOT_DOMAIN;
    if (root && (host === root || host.endsWith(`.${root}`))) return true;
    const clientHosts = [CLIENT_SIDE.HOST, ...Object.values(CLIENT_SIDE.URLS)].map(hostOf);
    return clientHosts.includes(host);
}

/**
 * The company's own domains as stored: normalized, without repeats, refusing a value that is not a host name
 * (`company_domain_invalid`) and a host another company already holds (`company_domain_taken`).
 */
export async function prepareCompanyDomains(
    raw: string[],
    companyId: ObjectId,
    ctx: {session: ClientSession; logger: serverLogger; languageCode: string},
): Promise<string[]> {
    const domains: string[] = [];
    for (const value of raw) {
        if (value.trim() === "") continue;
        const host = normalizeCompanyDomain(value);
        if (!host) throw apiValidationException("company_domain_invalid", "allowedDomains", [value.trim()], ctx.languageCode);
        if (!domains.includes(host)) domains.push(host);
    }
    const owned = domains.filter((host) => !isPlatformHost(host));
    if (owned.length > 0) {
        const holder = await companyService.findOne(
            {_id: {$ne: companyId}, allowedDomains: {$in: owned}},
            {session: ctx.session, logger: ctx.logger, languageCode: ctx.languageCode},
            null,
            "allowedDomains",
        );
        const taken = holder?.allowedDomains.find((host) => owned.includes(host));
        if (taken) throw apiValidationException("company_domain_taken", "allowedDomains", [taken], ctx.languageCode);
    }
    return domains;
}

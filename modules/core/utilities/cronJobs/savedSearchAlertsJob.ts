/**
 * Saved-search alerts (D178, P23.7).
 *
 * Once a day, every person with a saved search whose alert is on gets one email with what the portal's sections listed
 * since their last alert: a block per search with something new, its newest items, a link to all of them on the host
 * the search was saved on, and a link that stops that search's alerts. Sections answer through their optional
 * `newSince` (portal provider seam); a section without it is not asked.
 *
 * Saved searches are stored in the platform company, so only the platform company's run finds any. A person's searches
 * move on to this run's start once their email went out (or there was nothing new); when the send fails they stay, so
 * the next run sends what this one could not.
 *
 * @module savedSearchAlertsJob
 */

import type {ObjectId} from "mongodb";
import {getLogger, type serverLogger} from "@coreModule/loggers/serverLog";
import {clientHostFor} from "@coreModule/environment";
import {portalSavedSearchService} from "@coreModule/database/schemas/portalSavedSearch/portalSavedSearch.service";
import type {IPortalSavedSearch} from "@coreModule/database/schemas/portalSavedSearch/portalSavedSearch";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {inPortalScope} from "@coreModule/domain/portal/portalBrowse";
import {newPortalItemsSince} from "@coreModule/domain/portal/portalNewSince";
import {companySiteUrl} from "@coreModule/utilities/marketing/portalCompanies";
import {generateRecordAccessToken} from "@coreModule/utilities/security/recordAccessToken";
import {nestedEntityToRef} from "@coreModule/utilities/mappers/common.mapper";
import {
    sendSavedSearchAlertMail,
    type SavedSearchAlertBlock,
    type SavedSearchDigest,
} from "@coreModule/utilities/emails/savedSearchAlertMail";

/** The newest items a block shows per kind; the rest are counted. */
const ITEMS_PER_KIND = 6;

/** The record-access purpose of an alert's stop link: it can only turn that one search's alerts off. */
export const SAVED_SEARCH_STOP_PURPOSE = "savedSearchAlert";

export type SavedSearchAlertsResult = {
    searches: number;
    people: number;
    sent: number;
    failed: number;
    items: number;
};

type Deliver = (digest: SavedSearchDigest) => Promise<void>;

/** The portal page a search was saved on: a company's own site, or the apex. */
function hostBase(search: IPortalSavedSearch, siteSlugs: Map<string, string | undefined>): string {
    if (!search.siteCompany) return clientHostFor("portal").replace(/\/+$/, "");
    return companySiteUrl({_id: search.siteCompany, siteSlug: siteSlugs.get(search.siteCompany.toString())}, "");
}

/** The home catalog showing the search, newest first: the params the portal reads (`f.<name>` for a kind's filters). */
export function savedSearchResultsPath(search: Pick<IPortalSavedSearch, "kind" | "query" | "city" | "priceMin" | "priceMax" | "filters">): string {
    const params = new URLSearchParams();
    if (search.kind) params.set("kind", search.kind);
    if (search.query) params.set("q", search.query);
    if (search.city) params.set("city", search.city);
    if (search.priceMin != null) params.set("priceMin", String(search.priceMin));
    if (search.priceMax != null) params.set("priceMax", String(search.priceMax));
    for (const [name, value] of Object.entries(search.filters ?? {})) {
        for (const one of Array.isArray(value) ? value : [value]) params.append(`f.${name}`, one);
    }
    params.set("sort", "newest");
    return `/?${params}`;
}

/** `companyId` is the company the search is stored in (the platform company). */
function stopUrl(base: string, companyId: ObjectId, search: IPortalSavedSearch, languageCode: string): string {
    const token = generateRecordAccessToken({
        purpose: SAVED_SEARCH_STOP_PURPOSE,
        companyId,
        recordId: search._id,
        // The link can only stop this search's alerts, so older links stay valid.
        version: 0,
        languageCode,
    });
    return `${base}/saved-searches/stop?${new URLSearchParams({token})}`;
}

/**
 * Runs the alerts of the saved searches stored in `companyId` (the platform company holds them all). `deliver` sends
 * one person's digest; tests pass their own.
 */
export async function runSavedSearchAlerts(
    companyId: ObjectId,
    options: {logger?: serverLogger; now?: Date; deliver?: Deliver} = {},
): Promise<SavedSearchAlertsResult> {
    const logger = getLogger("saved_search_alerts", options.logger);
    const now = options.now ?? new Date();
    const deliver: Deliver = options.deliver ?? ((digest) => sendSavedSearchAlertMail(companyId, digest));
    const result: SavedSearchAlertsResult = {searches: 0, people: 0, sent: 0, failed: 0, items: 0};

    const searches = await portalSavedSearchService.findAlerting(companyId, {logger});
    if (searches.length === 0) return result;
    result.searches = searches.length;

    const byPerson = new Map<string, IPortalSavedSearch[]>();
    for (const search of searches) {
        const key = String(nestedEntityToRef(search.user));
        byPerson.set(key, [...(byPerson.get(key) ?? []), search]);
    }
    const people = await userService.find({_id: {$in: [...byPerson.keys()]}, isVisitor: {$ne: true}}, {logger}, undefined, "username name surname preferredLanguage");
    const peopleById = new Map(people.map((person) => [person._id.toString(), person]));
    const siteIds = [...new Set(searches.flatMap((search) => search.siteCompany ? [search.siteCompany.toString()] : []))];
    const sites = siteIds.length > 0 ? await companyService.find({_id: {$in: siteIds}}, {logger}, undefined, "_id siteSlug") : [];
    const siteSlugs = new Map(sites.map((site) => [site._id.toString(), site.siteSlug ?? undefined]));

    for (const [personId, own] of byPerson) {
        // A deleted account, or a chat visitor, gets nothing.
        const person = peopleById.get(personId);
        if (!person) continue;
        const languageCode = person.preferredLanguage ?? own[0].languageCode;
        const blocks: SavedSearchAlertBlock[] = [];
        const checked: IPortalSavedSearch[] = [];
        for (const search of own) {
            const scope = search.siteCompany ? {companyId: search.siteCompany} : {};
            try {
                const groups = await inPortalScope(scope, () => newPortalItemsSince(scope, search, search.lastAlertAt, {languageCode, limit: ITEMS_PER_KIND}));
                checked.push(search);
                const total = groups.reduce((sum, group) => sum + group.total, 0);
                if (total === 0) continue;
                const base = hostBase(search, siteSlugs);
                blocks.push({
                    label: search.label,
                    items: groups.flatMap((group) => group.items),
                    total,
                    resultsUrl: `${base}${savedSearchResultsPath(search)}`,
                    stopUrl: stopUrl(base, companyId, search, languageCode),
                });
            } catch (error) {
                // One section failing keeps this search for the next run; the person's other searches still go out.
                logger.warn(`Saved search ${search._id.toString()} could not be checked`, error);
            }
        }
        result.people += 1;
        if (blocks.length > 0) {
            try {
                await deliver({email: person.username, fullName: [person.name, person.surname].filter(Boolean).join(" "), languageCode, blocks});
                result.sent += 1;
                result.items += blocks.reduce((sum, block) => sum + block.total, 0);
            } catch (error) {
                result.failed += 1;
                logger.err(`The saved-search alert to user ${person._id.toString()} could not be sent`, error);
                continue;
            }
        }
        if (checked.length > 0) {
            await portalSavedSearchService.updateMany({_id: {$in: checked.map((search) => search._id)}}, {$set: {lastAlertAt: now}}, {logger});
        }
    }
    return result;
}

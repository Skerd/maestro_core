import {Router} from "express";
import {ObjectId} from "mongodb";
import authMW, {type AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import type {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";
import {
    PORTAL_FAVOURITES_MAX,
    PORTAL_SAVED_SEARCHES_MAX,
    portalFavouriteFormSchema,
    portalFavouriteRemoveFormSchema,
    portalSavedSearchAlertsFormSchema,
    portalSavedSearchFormSchema,
    type PortalFavouriteFormType,
    type PortalFavouriteRemoveFormType,
    type PortalSavedSearchAlertsFormType,
    type PortalSavedSearchFormType,
} from "armonia/src/modules/core/api/portal/private/saved/portalSaved.form.validator";
import type {
    PortalFavouriteKeysResponse,
    PortalSavedResponse,
    PortalSavedSearchResponse,
} from "armonia/src/modules/core/api/portal/private/saved/portalSaved.dto";
import {portalFavouriteService} from "@coreModule/database/schemas/portalFavourite/portalFavourite.service";
import {portalSavedSearchService} from "@coreModule/database/schemas/portalSavedSearch/portalSavedSearch.service";
import {listPortalProviders} from "@coreModule/domain/portal/portalProviderRegistry";
import {hostCompany, inPortalScope} from "@coreModule/domain/portal/portalBrowse";
import {portalItemsByIds} from "@coreModule/domain/portal/portalNewSince";
import {findPlatformCompany} from "@coreModule/utilities/marketing/portalCompanies";
import {resolveEmailLocaleTag} from "@coreModule/utilities/emails/emailLocale";
import {portalFavouriteKey, portalSavedSearchToDTO} from "@coreModule/utilities/mappers/portal/portalSavedMapper.dto";

/**
 * What a portal account keeps (D178, P23.7): the catalog items they hearted and the searches they saved, one list per
 * person across every company and host, stored in the platform company like the address book (D163). Every route
 * reaches only the signed-in person's own rows.
 * - POST ""                  — the Saved tab: kept items as this host's catalog lists them now, and the saved searches
 * - POST /favourites/keys    — the kept items as `<kind>:<id>`, for the hearts on the cards
 * - PUT, DELETE /favourites  — keep or drop an item (answers with the keys)
 * - PUT, DELETE /searches    — save or delete a search (the home catalog's browse query)
 * - POST /searches/alerts    — turn one search's daily alert on or off
 * The alert's stop link is public: `api/portal/public/savedSearchAlerts.ts`.
 */
export const basePath = "/api/portal/saved";
export const router = Router();

function assertPortalKind(kind: string, languageCode: string): void {
    if (!listPortalProviders().some((provider) => provider.kinds.includes(kind))) {
        throw apiValidationException("not_found", "kind", null, languageCode);
    }
}

async function favouriteKeys(params: AuthenticatedMWType & {session?: TransactionRequiredParams["session"]}): Promise<PortalFavouriteKeysResponse> {
    const {logger, languageCode, session} = params;
    const favourites = await portalFavouriteService.findOwn(params.actionUserCtx.userId, {logger, languageCode, session});
    return {data: favourites.map(portalFavouriteKey)};
}

router.post(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(async (params: AuthenticatedMWType): Promise<PortalSavedResponse> => {
        const {origin, logger, languageCode, actionUserCtx} = params;
        const [favourites, searches, {scope}] = await Promise.all([
            portalFavouriteService.findOwn(actionUserCtx.userId, {logger, languageCode}),
            portalSavedSearchService.findOwn(actionUserCtx.userId, {logger, languageCode}),
            hostCompany(origin, languageCode),
        ]);
        const items = await inPortalScope(scope, () => portalItemsByIds(
            scope,
            favourites.map((favourite) => ({kind: favourite.kind, itemId: favourite.itemId})),
            languageCode,
        ));
        return {
            data: {
                favourites: items,
                unavailable: favourites.length - items.length,
                searches: searches.map(portalSavedSearchToDTO),
            },
        };
    }),
);

router.post(
    "/favourites/keys",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 120}),
    asyncHandler(favouriteKeys),
);

router.put(
    "/favourites",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(portalFavouriteFormSchema),
    transactionHandler(),
    asyncHandler(async (params: TransactionRequiredParams & PortalFavouriteFormType): Promise<PortalFavouriteKeysResponse> => {
        const {kind, id, section, path, logger, languageCode, session, actionUserCtx} = params;
        assertPortalKind(kind, languageCode);
        const own = await portalFavouriteService.ownClause(actionUserCtx.userId);
        const kept = await portalFavouriteService.findOne({...own, kind, itemId: id}, {logger, languageCode, session, withDeleted: false});
        if (!kept) {
            const count = await portalFavouriteService.count(own, {logger, languageCode, session});
            if (count >= PORTAL_FAVOURITES_MAX) {
                throw apiValidationException("portal_favourites_limit_reached", null, null, languageCode, [String(PORTAL_FAVOURITES_MAX)]);
            }
            const platform = await findPlatformCompany(languageCode);
            await portalFavouriteService.create(
                {user: new ObjectId(actionUserCtx.userId), kind, itemId: id, section, path, company: platform._id},
                {logger, languageCode, session, auditUserId: actionUserCtx.userId},
            );
        }
        return favouriteKeys(params);
    }),
);

router.delete(
    "/favourites",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(portalFavouriteRemoveFormSchema),
    transactionHandler(),
    asyncHandler(async (params: TransactionRequiredParams & PortalFavouriteRemoveFormType): Promise<PortalFavouriteKeysResponse> => {
        const {kind, id, logger, languageCode, session, actionUserCtx} = params;
        const own = await portalFavouriteService.ownClause(actionUserCtx.userId);
        const kept = await portalFavouriteService.find({...own, kind, itemId: id}, {logger, languageCode, session, withDeleted: false});
        for (const favourite of kept) {
            await portalFavouriteService.deleteById(favourite._id, {logger, languageCode, session, auditUserId: actionUserCtx.userId});
        }
        return favouriteKeys(params);
    }),
);

router.put(
    "/searches",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 30}),
    validateFormZod(portalSavedSearchFormSchema),
    transactionHandler(),
    asyncHandler(async (params: TransactionRequiredParams & PortalSavedSearchFormType): Promise<PortalSavedSearchResponse> => {
        const {origin, logger, languageCode, session, actionUserCtx} = params;
        if (params.kind) assertPortalKind(params.kind, languageCode);
        const own = await portalSavedSearchService.ownClause(actionUserCtx.userId);
        const count = await portalSavedSearchService.count(own, {logger, languageCode, session});
        if (count >= PORTAL_SAVED_SEARCHES_MAX) {
            throw apiValidationException("portal_saved_searches_limit_reached", null, null, languageCode, [String(PORTAL_SAVED_SEARCHES_MAX)]);
        }
        const [platform, {scope}] = await Promise.all([findPlatformCompany(languageCode), hostCompany(origin, languageCode)]);
        const created = await portalSavedSearchService.create(
            {
                user: new ObjectId(actionUserCtx.userId),
                label: params.label,
                kind: params.kind,
                query: params.query?.trim() || undefined,
                city: params.city?.trim() || undefined,
                priceMin: params.priceMin,
                priceMax: params.priceMax,
                filters: params.filters ?? {},
                // The alert searches the host the search was saved on: a company's own site, or the apex.
                siteCompany: scope.companyId,
                languageCode: resolveEmailLocaleTag(languageCode),
                alerts: true,
                // The first alert brings what is listed from now on.
                lastAlertAt: new Date(),
                company: platform._id,
            },
            {logger, languageCode, session, auditUserId: actionUserCtx.userId},
        );
        return {data: portalSavedSearchToDTO(created)};
    }),
);

router.delete(
    "/searches",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 30}),
    validateFormZod(validateSingleForm),
    transactionHandler(),
    asyncHandler(async (params: TransactionRequiredParams & {_id: string}) => {
        const {_id, logger, languageCode, session, actionUserCtx} = params;
        const own = await portalSavedSearchService.ownClause(actionUserCtx.userId);
        const search = await portalSavedSearchService.findOne({...own, _id: new ObjectId(_id)}, {logger, languageCode, session, withDeleted: false});
        if (!search) throw apiValidationException("not_found", "_id", null, languageCode);
        await portalSavedSearchService.deleteById(search._id, {logger, languageCode, session, auditUserId: actionUserCtx.userId});
        return {data: {_id}};
    }),
);

router.post(
    "/searches/alerts",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 30}),
    validateFormZod(portalSavedSearchAlertsFormSchema),
    transactionHandler(),
    asyncHandler(async (params: TransactionRequiredParams & PortalSavedSearchAlertsFormType): Promise<PortalSavedSearchResponse> => {
        const {_id, alerts, logger, languageCode, session, actionUserCtx} = params;
        const own = await portalSavedSearchService.ownClause(actionUserCtx.userId);
        const search = await portalSavedSearchService.findOne({...own, _id: new ObjectId(_id)}, {logger, languageCode, session, withDeleted: false});
        if (!search) throw apiValidationException("not_found", "_id", null, languageCode);
        // Turned back on, the next alert starts from now rather than from the day it was turned off.
        search.set(alerts && !search.alerts ? {alerts, lastAlertAt: new Date()} : {alerts});
        search.$locals = search.$locals || {};
        search.$locals.auditUserId = new ObjectId(actionUserCtx.userId);
        await search.save({session});
        return {data: portalSavedSearchToDTO(search)};
    }),
);

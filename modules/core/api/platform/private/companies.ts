import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {runAfterCommit, TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {dslFilterMW, DslFilterMWType} from "@coreModule/utilities/middlewares/dslFilterMW";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {TableForm, TableResponse} from "armonia/src/modules/core/types/shared.types";
import {validateTableForm} from "armonia/src/modules/core/utilities/zod/shared.validator";
import {Company as CompanyData} from "armonia/src/modules/core/api/company/private/company/company.dto";
import {SetCompanyModulesFormType} from "armonia/src/modules/core/api/platform/private/companies/setCompanyModules.form.type";
import {setCompanyModulesSchema} from "armonia/src/modules/core/api/platform/private/companies/setCompanyModules.form.validator";
import {
    PlatformModulesResponse,
    SetCompanyModulesResponse,
    SetPortalVisibilityResponse,
} from "armonia/src/modules/core/api/platform/private/companies/platformModules.dto";
import {SetPortalVisibilityFormType} from "armonia/src/modules/core/api/platform/private/companies/setPortalVisibility.form.type";
import {setPortalVisibilitySchema} from "armonia/src/modules/core/api/platform/private/companies/setPortalVisibility.form.validator";
import Company from "@coreModule/database/schemas/company/company";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {COLLECTED_DATA} from "@coreModule/database/collections";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {COMPANY_MODULE_FIELDS, companyToDTO} from "@coreModule/utilities/mappers/company/companyMapper.dto";
import {getEnabledModuleNames, loadModuleManifest} from "@coreModule/utilities/modules/enabledModules";
import {
    closeCompanyModules,
    effectiveCompanyModules,
    invalidateCompanyModules,
} from "@coreModule/utilities/modules/companyModules";
import {skipMissedCronRuns} from "@coreModule/cronjobs/bootstrap/seedCompanyJobs";
import {assertCompanyChangeAllowed, assertPlatformAdmin} from "@coreModule/utilities/security/platformAccess";

/**
 * Platform administration of companies (Private)
 *
 * Only admins of the platform-owner company (`Company.isPlatformOwner`) may call these:
 * - GET  /modules     — module catalog (manifest + what this server has installed)
 * - POST ""           — every company on the platform, paginated, Filter DSL via body
 * - PUT  /modules/:id — grant a company its modules
 * - PUT  /portalVisibility/:id — hide a company from (or show it on) the portal and shop apex
 *
 * @module modules/core/api/platform/companies
 */
const router = Router();

/**
 * GET /api/platform/companies/modules
 *
 * @returns {Promise<PlatformModulesResponse>} every manifest module, flagged installed or not
 */
router.get(
    "/modules",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(getModules)
);

async function getModules(params: AuthenticatedMWType): Promise<PlatformModulesResponse> {
    assertPlatformAdmin(params);
    const installed = new Set(getEnabledModuleNames());
    const data = Object.entries(loadModuleManifest())
        .filter(([, entry]) => !entry.sinfoniaOnly)
        .map(([name, entry]) => ({
            name,
            ...(entry.description ? {description: entry.description} : {}),
            required: entry.required === true,
            dependsOn: (entry.dependsOn ?? []).filter((dep) => dep !== name),
            installed: installed.has(name),
        }));
    return {data};
}

/**
 * POST /api/platform/companies
 *
 * @body {TableForm} - offset, limit, sortBy?, sortOrder?, filter?
 * @returns {Promise<TableResponse<CompanyData>>} all companies, read fields per the caller's permissions
 */
router.post(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(validateTableForm),
    dslFilterMW({model: "companies"}),
    asyncHandler(listCompanies)
);
type ListCompaniesType = AuthenticatedMWType & DslFilterMWType & TableForm;

async function listCompanies(params: ListCompaniesType): Promise<TableResponse<CompanyData>> {
    assertPlatformAdmin(params);
    const {logger, languageCode, actionUserCtx, offset, limit, sortBy, sortOrder, dslFilterQuery} = params;

    const filter: Record<string, unknown> = dslFilterQuery && Object.keys(dslFilterQuery as object).length > 0
        ? {$and: [dslFilterQuery]}
        : {};
    const sort: Record<string, 1 | -1> = sortBy && sortOrder ? {[sortBy]: sortOrder === "asc" ? 1 : -1} : {name: 1};
    const opts = {logger, languageCode};

    const readFields = SchemaGuard.sanitizeFields(Company, COLLECTED_DATA["companies"]?.readFields || {}, "read", actionUserCtx, languageCode);
    const populate = SchemaGuard.generatePopulate(readFields, Company.schema);
    const select = populate.select && `${populate.select} company ${COMPANY_MODULE_FIELDS}`;

    const [companies, total] = await Promise.all([
        companyService.find(filter, opts, populate.populate || [], select, sort, limit, offset),
        companyService.count(filter, opts),
    ]);
    return {
        data: companies.map((company) => companyToDTO(company)).filter((dto): dto is CompanyData => dto !== null),
        total,
    };
}

/**
 * PUT /api/platform/companies/modules/:id
 *
 * Stores the dependency closure of the requested modules (grants of modules this server
 * does not install are kept), then gives the company the default roles and cron jobs of
 * its new modules. Removing a module only hides it; its data, roles and jobs stay.
 *
 * @returns {Promise<SetCompanyModulesResponse>} stored grant and effective modules
 */
router.put(
    "/modules/:id",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 30}),
    transactionHandler(),
    validateFormZod(setCompanyModulesSchema),
    asyncHandler(setCompanyModules)
);
type SetCompanyModulesType = TransactionRequiredParams & SetCompanyModulesFormType;

async function setCompanyModules(params: SetCompanyModulesType, routeParams: {id: string}): Promise<SetCompanyModulesResponse> {
    assertPlatformAdmin(params);
    const {logger, languageCode, session, actionUserCtx, modules} = params;
    if (!ObjectId.isValid(routeParams.id)) {
        throw apiValidationException("not_found", "", null, languageCode);
    }

    const target = await companyService.findById(new ObjectId(routeParams.id), {session});
    if (!target) {
        throw apiValidationException("not_found", "", null, languageCode);
    }

    logger.start(`Setting modules of company '${target.name}'...`);
    const installed = new Set(getEnabledModuleNames());
    const before = effectiveCompanyModules(target);
    // The panel only offers installed modules; keep grants it could not show.
    const keptUninstalled = (target.modules ?? []).filter((name) => !installed.has(name));
    const next = closeCompanyModules([...modules, ...keptUninstalled]);
    assertCompanyChangeAllowed(target, {removedModules: (target.modules ?? []).filter((name) => !next.includes(name))}, languageCode);
    target.modules = next;
    target.$locals = target.$locals || {};
    target.$locals.auditUserId = actionUserCtx.userId;
    await target.save({session});

    const after = effectiveCompanyModules(target);
    const enabled = after.filter((name) => !before.includes(name));
    if (enabled.length > 0) {
        await target.createDefaultRoles(logger, session);
        await target.seedCronJobs(session);
        await skipMissedCronRuns(target._id, enabled, session);
    }
    await runAfterCommit(session, () => invalidateCompanyModules(target._id));

    logger.finish(`Company '${target.name}' modules: ${after.join(", ")}`);
    return {_id: target._id.toString(), granted: [...target.modules], modules: after};
}

/**
 * PUT /api/platform/companies/portalVisibility/:id
 *
 * The platform owner's override over a company's own opt-ins (`listedOnPortal`,
 * `shopListedOnPortal`): a hidden company is left off the portal and the shop apex.
 */
router.put(
    "/portalVisibility/:id",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 30}),
    transactionHandler(),
    validateFormZod(setPortalVisibilitySchema),
    asyncHandler(setPortalVisibility)
);
type SetPortalVisibilityType = TransactionRequiredParams & SetPortalVisibilityFormType;

async function setPortalVisibility(params: SetPortalVisibilityType, routeParams: {id: string}): Promise<SetPortalVisibilityResponse> {
    assertPlatformAdmin(params);
    const {logger, languageCode, session, actionUserCtx, hiddenFromPortal} = params;
    if (!ObjectId.isValid(routeParams.id)) {
        throw apiValidationException("not_found", "", null, languageCode);
    }
    const target = await companyService.findById(new ObjectId(routeParams.id), {session});
    if (!target) {
        throw apiValidationException("not_found", "", null, languageCode);
    }
    assertCompanyChangeAllowed(target, {hideFromPortal: hiddenFromPortal}, languageCode);
    target.hiddenFromPortal = hiddenFromPortal;
    target.$locals = target.$locals || {};
    target.$locals.auditUserId = actionUserCtx.userId;
    await target.save({session});
    logger.debug(`Company '${target.name}' ${hiddenFromPortal ? "hidden from" : "shown on"} the portal`);
    return {_id: target._id.toString(), hiddenFromPortal: target.hiddenFromPortal};
}

export {router};

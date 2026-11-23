import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {runAfterCommit, TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {dslFilterMW, DslFilterMWType} from "@coreModule/utilities/middlewares/dslFilterMW";
import {schemaSanitizer} from "@coreModule/utilities/middlewares/schemaSanitizerMW";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {TableForm, TableResponse} from "armonia/src/modules/core/types/shared.types";
import {validateTableForm} from "armonia/src/modules/core/utilities/zod/shared.validator";
import {Company as CompanyData} from "armonia/src/modules/core/api/company/private/company/company.dto";
import {runModuleCompanyDefaults} from "@coreModule/utilities/modules/moduleCompanyDefaults";
import {SetCompanyModulesFormType} from "armonia/src/modules/core/api/platform/private/companies/setCompanyModules.form.type";
import {setCompanyModulesSchema} from "armonia/src/modules/core/api/platform/private/companies/setCompanyModules.form.validator";
import {
    CompanyTreeNode,
    CompanyTreeResponse,
    PlatformModulesResponse,
    SetCompanyModulesResponse,
    SetCompanyVerificationResponse,
    SetPortalApprovalResponse,
    SetPortalVisibilityResponse,
} from "armonia/src/modules/core/api/platform/private/companies/platformModules.dto";
import {
    setPortalApprovalSchema,
    type SetPortalApprovalFormType,
} from "armonia/src/modules/core/api/platform/private/companies/setPortalApproval.form.validator";
import {
    setCompanyVerificationSchema,
    type SetCompanyVerificationFormType,
} from "armonia/src/modules/core/api/platform/private/companies/setCompanyVerification.form.validator";
import {SetPortalVisibilityFormType} from "armonia/src/modules/core/api/platform/private/companies/setPortalVisibility.form.type";
import {setPortalVisibilitySchema} from "armonia/src/modules/core/api/platform/private/companies/setPortalVisibility.form.validator";
import Company from "@coreModule/database/schemas/company/company";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {COLLECTED_DATA} from "@coreModule/database/collections";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {COMPANY_MODULE_FIELDS, companyToDTO} from "@coreModule/utilities/mappers/company/companyMapper.dto";
import {nestedEntityToRef} from "@coreModule/utilities/mappers/common.mapper";
import {getEnabledModuleNames, loadModuleManifest} from "@coreModule/utilities/modules/enabledModules";
import {
    closeCompanyModules,
    effectiveCompanyModules,
    invalidateCompanyModules,
} from "@coreModule/utilities/modules/companyModules";
import {skipMissedCronRuns} from "@coreModule/cronjobs/bootstrap/seedCompanyJobs";
import {assertCompanyChangeAllowed, assertPlatformAdmin} from "@coreModule/utilities/security/platformAccess";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {notifyPortalApprovalDecided} from "@coreModule/domain/company/companySignupNotices";

/**
 * Platform administration of companies (Private)
 *
 * Only admins of the platform-owner company (`Company.isPlatformOwner`) may call these:
 * - GET  /modules     — module catalog (manifest + what this server has installed)
 * - POST ""           — every company on the platform, paginated, Filter DSL via body
 * - GET  /tree        — every company with the company it was created under (the hierarchy view)
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
    // The filter compiles against the fields the caller may read; without it every search and filter was refused.
    schemaSanitizer({model: "companies", requiredModes: ["read"]}),
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
    // A company's logo is a Media row in that company's own tenant, so populating it from the platform's request finds
    // nothing and drops the id. The list only needs the id: the panel loads it as public media.
    const populateRefs = ([] as Array<{path?: string}>).concat(populate.populate ?? []).filter((ref) => ref.path !== "logo");

    const [companies, total] = await Promise.all([
        companyService.find(filter, opts, populateRefs, select, sort, limit, offset),
        companyService.count(filter, opts),
    ]);
    return {
        data: companies.map((company) => companyToDTO(company)).filter((dto): dto is CompanyData => dto !== null),
        total,
    };
}

/**
 * GET /api/platform/companies/tree
 *
 * Every company with the company it was created under, for the hierarchy view. The rows are light (no addresses, no
 * populated references), so the whole platform fits in one answer and the panel builds the tree.
 *
 * @returns {Promise<CompanyTreeResponse>} all companies by name, read fields per the caller's permissions
 */
router.get(
    "/tree",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(getCompanyTree)
);

/** What a node shows; each is read only when the caller's permissions allow it (SEC-09). */
const COMPANY_TREE_FIELDS = {name: {}, logo: {}, vat: {}, parentCompany: {}, isActive: {}};

async function getCompanyTree(params: AuthenticatedMWType): Promise<CompanyTreeResponse> {
    assertPlatformAdmin(params);
    const {logger, languageCode, actionUserCtx} = params;
    logger.start(`Fetching the company hierarchy...`);

    const readable = new Set(Object.keys(SchemaGuard.sanitizeFields(Company, COMPANY_TREE_FIELDS, "read", actionUserCtx, languageCode)));
    // Platform-managed facts, loaded like the list's (COMPANY_MODULE_FIELDS), not permission-gated fields.
    const select = [...readable, "isPlatformOwner", "portalApproval.status"].join(" ");
    // A deleted company is not part of the hierarchy, though an admin's reads see deleted rows (to restore them).
    const companies = await companyService.find({}, {logger, languageCode, withDeleted: false}, [], select, {name: 1});

    const data = companies.map((company): CompanyTreeNode => ({
        _id: company._id.toString(),
        ...(readable.has("name") ? {name: company.name} : {}),
        ...(readable.has("logo") && company.logo ? {logo: company.logo.toString()} : {}),
        ...(readable.has("vat") && company.vat ? {vat: company.vat} : {}),
        // Not populated: the parent's id is all the tree needs, and its name is on its own row.
        ...(readable.has("parentCompany") && company.parentCompany ? {parentCompany: nestedEntityToRef(company.parentCompany)?.toString()} : {}),
        ...(readable.has("isActive") ? {isActive: company.isActive} : {}),
        isPlatformOwner: company.isPlatformOwner === true,
        ...(company.portalApproval?.status ? {portalApprovalStatus: company.portalApproval.status} : {}),
    }));

    logger.finish(`Fetched the hierarchy of ${data.length} companies!`);
    return {data};
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

    const after = effectiveCompanyModules(target);
    const enabled = after.filter((name) => !before.includes(name));
    // The target's own rows (its logo's media, roles, jobs) are written in its tenant, not the platform's (TD-B188).
    await withTenant(target._id, async () => {
        await target.save({session});
        if (enabled.length > 0) {
            await target.createDefaultRoles(logger, session);
            await target.seedCronJobs(session);
            await skipMissedCronRuns(target._id, enabled, session);
            // What each newly granted module sets up for a company (TD-B254), e.g. property's starter unit types.
            await runModuleCompanyDefaults(target, enabled, {session, logger, languageCode});
        }
    });
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
    // Saved in the target's tenant: its public-media plugin touches the target's logo (TD-B188).
    await withTenant(target._id, () => target.save({session}));
    logger.debug(`Company '${target.name}' ${hiddenFromPortal ? "hidden from" : "shown on"} the portal`);
    return {_id: target._id.toString(), hiddenFromPortal: target.hiddenFromPortal};
}

/**
 * PUT /api/platform/companies/portalApproval/:id
 *
 * The platform's decision on listing a self-serve company on the portal apex (D178): approved lists it, rejected keeps
 * it off, with a reason its admins are told. Its own site works either way; hiding (portalVisibility) stays the
 * platform's override for every company.
 */
router.put(
    "/portalApproval/:id",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 30}),
    transactionHandler(),
    validateFormZod(setPortalApprovalSchema),
    asyncHandler(setPortalApproval)
);
type SetPortalApprovalType = TransactionRequiredParams & SetPortalApprovalFormType;

async function setPortalApproval(params: SetPortalApprovalType, routeParams: {id: string}): Promise<SetPortalApprovalResponse> {
    assertPlatformAdmin(params);
    const {logger, languageCode, session, actionUserCtx, status} = params;
    if (!ObjectId.isValid(routeParams.id)) {
        throw apiValidationException("not_found", "", null, languageCode);
    }
    const target = await companyService.findById(new ObjectId(routeParams.id), {session});
    if (!target) {
        throw apiValidationException("not_found", "", null, languageCode);
    }
    // A company the platform cannot run without is never kept off the portal.
    assertCompanyChangeAllowed(target, {hideFromPortal: status === "rejected"}, languageCode);
    const reason = status === "rejected" ? params.reason?.trim() || undefined : undefined;
    const decidedAt = new Date();
    target.portalApproval = {status, decidedBy: new ObjectId(actionUserCtx.userId), decidedAt, ...(reason ? {reason} : {})};
    target.$locals = target.$locals || {};
    target.$locals.auditUserId = actionUserCtx.userId;
    // Saved in the target's tenant: its public-media plugin touches the target's logo (TD-B188).
    await withTenant(target._id, () => target.save({session}));
    await notifyPortalApprovalDecided({_id: target._id, name: target.name}, {status, reason}, {languageCode, session});
    logger.debug(`Company '${target.name}' ${status} for the portal`);
    return {_id: target._id.toString(), portalApproval: {status, decidedAt: decidedAt.toISOString(), ...(reason ? {reason} : {})}};
}

/**
 * PUT /api/platform/companies/verification/:id
 *
 * The platform marks a company verified after checking its NIPT/VAT, or takes the mark back (D178). The mark needs a
 * VAT, and changing the VAT later clears it.
 */
router.put(
    "/verification/:id",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 30}),
    transactionHandler(),
    validateFormZod(setCompanyVerificationSchema),
    asyncHandler(setCompanyVerification)
);
type SetCompanyVerificationType = TransactionRequiredParams & SetCompanyVerificationFormType;

async function setCompanyVerification(params: SetCompanyVerificationType, routeParams: {id: string}): Promise<SetCompanyVerificationResponse> {
    assertPlatformAdmin(params);
    const {logger, languageCode, session, actionUserCtx, verified} = params;
    if (!ObjectId.isValid(routeParams.id)) {
        throw apiValidationException("not_found", "", null, languageCode);
    }
    const target = await companyService.findById(new ObjectId(routeParams.id), {session});
    if (!target) {
        throw apiValidationException("not_found", "", null, languageCode);
    }
    if (verified && !target.vat?.trim()) {
        throw apiValidationException("company_verification_needs_vat", "vat", null, languageCode);
    }
    target.set("verifiedAt", verified ? new Date() : undefined);
    target.set("verifiedBy", verified ? new ObjectId(actionUserCtx.userId) : undefined);
    target.$locals = target.$locals || {};
    target.$locals.auditUserId = actionUserCtx.userId;
    await withTenant(target._id, () => target.save({session}));
    logger.debug(`Company '${target.name}' ${verified ? "verified" : "no longer verified"}`);
    return {_id: target._id.toString(), verifiedAt: target.verifiedAt?.toISOString() ?? null};
}

export {router};

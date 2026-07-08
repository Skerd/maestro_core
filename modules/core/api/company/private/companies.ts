import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {
    BasicCompanyInfoFormResponseType,
    Company as CompanyData
} from "armonia/src/modules/core/api/company/private/company/company.dto";
import {allCompaniesFormSchema} from "armonia/src/modules/core/api/company/private/company/company.form.validator";
import {companyToDTO} from "@coreModule/utilities/mappers/company/companyMapper.dto";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import Company from "@coreModule/database/schemas/company/company";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {dslFilterMW, DslFilterMWType} from "@coreModule/utilities/middlewares/dslFilterMW";
import {COLLECTED_DATA} from "@coreModule/database/collections";
import {CompanyFormType} from "armonia/src/modules/core/api/company/private/company/company.form.type";
import {TableResponse} from "armonia/src/modules/core/types/shared.types";
import {SchemaSanitizerMWType} from "@coreModule/utilities/middlewares/schemaSanitizerMW";

/**
 * Companies Listing Endpoints (Private)
 *
 * This module provides private endpoints for listing companies:
 * - POST "" — Paginated list of all accessible companies with full details
 * - GET /basicInfo — Basic info (name, description, logo) for all accessible companies
 *
 * Scoped to userInfo.companies. All endpoints require authentication.
 *
 * @module modules/core/api/company/companies
 */
const router = Router();

/**
 * POST /api/companies
 *
 * Returns all companies accessible to the user. Paginated; Filter DSL via body.
 *
 * @route POST /api/companies
 * @access Private
 * @body {TableForm} - offset, limit, sortBy?, sortOrder?, filter?
 * @returns {Promise<TableResponse<CompanyData>>} { data, total }
 *
 * @remarks
 * - Uses userInfo.companies as scope; per-company permission resolution
 * - Filter DSL via dslFilterMW
 */
router.post(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(allCompaniesFormSchema),
    dslFilterMW({ model: "companies" }),
    asyncHandler(getCompanies)
);
type GetCompaniesType = AuthenticatedMWType & DslFilterMWType & SchemaSanitizerMWType & CompanyFormType;
/**
 * Paginated list of companies with role-resolved permissions.
 *
 * @param params - Auth, list form, dslFilterQuery
 * @returns Company DTOs and total count
 * @remarks Fetches company ids first, then full company per id with role-resolved permissions
 */
async function getCompanies(params: GetCompaniesType): Promise<TableResponse<CompanyData>> {
    const {logger, userInfo, languageCode, actionUserCtx, actionUserInfo, offset, limit, sortBy, sortOrder, dslFilterQuery, sanitizedReadFields} = params;

    logger.start(`Trying to get all companies (offset ${offset}, limit ${limit})...`);

    const companyIds = userInfo.companies.map((c: { _id?: ObjectId }) => c._id ?? c);
    const filterQuery: Record<string, unknown> = { _id: { $in: companyIds } };
    if (dslFilterQuery && Object.keys(dslFilterQuery as object).length > 0) {
        filterQuery.$and = [...((filterQuery.$and as unknown[]) ?? []), dslFilterQuery];
    }

    const opts = { logger, languageCode };
    const sort: Record<string, 1 | -1> = sortBy && sortOrder ? { [sortBy]: sortOrder === "asc" ? 1 : -1 } : { name: 1 };

    const [companyIdsResult, total] = await Promise.all([
        companyService.find(filterQuery, opts, undefined, "_id", sort, limit, offset),
        companyService.count(filterQuery, opts)
    ]);

    const data = await Promise.all(
        companyIdsResult.map(async (company) => {
            const permissions = company._id.toString() === actionUserCtx.orgId ? actionUserCtx.permissions : await actionUserInfo.getCompanyRolePermissions(company._id);
            const ctx = { ...actionUserCtx, permissions };

            const companyFields = COLLECTED_DATA["companies"]?.readFields || {};
            const perCompanyFields = SchemaGuard.sanitizeFields(Company, companyFields, "read", ctx, languageCode);
            const perCompanyPopulate = SchemaGuard.generatePopulate(perCompanyFields, Company.schema);
            const fullCompany = await companyService.findOneOrThrow(
                company._id,
                { logger, languageCode },
                perCompanyPopulate.populate || [],
                perCompanyPopulate.select + " company"
            );
            return companyToDTO(fullCompany);
        })
    );

    logger.finish(`Finished fetching companies (${data.length} of ${total})!`);

    return { data, total };
}

/**
 * GET /api/companies/basicInfo
 *
 * Returns basic information (name, description, logo) for all companies accessible to the user.
 *
 * @route GET /api/companies/basicInfo
 * @access Private
 * @returns {Promise<BasicCompanyInfoFormResponseType[]>} Array of basic company information
 *
 * @remarks
 * - For non-admin users: returns only companies where user has active, unlocked roles
 * - For admin users: returns all companies from userInfo.companies
 */
router.get(
    "/basicInfo",
    authMW("private"),
    rateLimiter({
        windowMs: 60000,
        max: 120
    }),
    asyncHandler(getCompaniesBasicInfo)
);
type GetCompaniesBasicInfoType = AuthenticatedMWType;
/**
 * Fetches basic information for all accessible companies with role-based filtering.
 *
 * @param params - Auth context
 * @returns Array of basic company information
 * @remarks Merges immediate (active/unlocked) and admin company ids; filters null results
 */
async function getCompaniesBasicInfo(params: GetCompaniesBasicInfoType): Promise<BasicCompanyInfoFormResponseType[]> {
    const { logger, languageCode, actionUserCtx, actionUserInfo } = params;

    logger.start(`Trying to get all companies basic info...`);

    const immediateCompanyIds: ObjectId[] = [];
    const adminCheckRoles: typeof actionUserInfo.roles = [];
    for( const role of actionUserInfo.roles ){
        const isActive = role.active === "active";
        const isNotLocked = !role.lockedOutUntil || role.lockedOutUntil < new Date();
        if( isActive && isNotLocked ){
            immediateCompanyIds.push(role.company._id);
        }
        else{
            adminCheckRoles.push(role);
        }
    }

    const adminChecks = await Promise.all(adminCheckRoles.map(async (role) => ({
        role,
        isAdmin: await actionUserInfo.isAdmin(role.company._id)
    })));
    const adminCompanyIds = adminChecks.filter((check) => check.isAdmin).map((check) => check.role.company._id);

    const uniqueCompanyIds = new Map<string, ObjectId>();
    for (const companyId of immediateCompanyIds) {
        uniqueCompanyIds.set(companyId.toString(), companyId);
    }
    for (const companyId of adminCompanyIds) {
        uniqueCompanyIds.set(companyId.toString(), companyId);
    }

    const allCompanies = await Promise.all(Array.from(uniqueCompanyIds.values()).map(async (companyId) => {
        const permissions = companyId.toString() === actionUserCtx.orgId
            ? actionUserCtx.permissions
            : await actionUserInfo.getCompanyRolePermissions(companyId);
        const ctx = { ...actionUserCtx, permissions };
        const sanitizedFields = SchemaGuard.sanitizeFields(Company, {name: {}, description: {}, logo: {}}, "read", ctx, languageCode);
        const populate = SchemaGuard.generatePopulate(sanitizedFields, Company.schema);

        const companyData = await companyService.findById(
            companyId,
            { logger, languageCode },
            populate.populate,
            populate.select
        );

        if( !companyData ){
            return null;
        }

        const logoValue = companyData.logo
            ? (companyData.logo as any)._id
                ? (companyData.logo as any)._id.toString()
                : (companyData.logo as any).toString()
            : null;

        return {
            _id: companyData._id.toString(),
            name: companyData.name,
            description: companyData.description,
            logo: logoValue
        };
    }));
    logger.finish(`Finished fetching all companies basic info!`);

    return allCompanies.filter((company): company is BasicCompanyInfoFormResponseType => !!company);
}


export const basePath = '/api/companies';
export { router };
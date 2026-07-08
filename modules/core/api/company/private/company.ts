import {Router} from "express";
import {Decimal128, ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {
    BasicCompanyInfoFormResponseType,
    Company as CompanyData
} from "armonia/src/modules/core/api/company/private/company/company.dto";
import {
    createCompanyFormSchema
} from "armonia/src/modules/core/api/company/private/company/createCompany.form.validator";
import {editCompanyFormSchema} from "armonia/src/modules/core/api/company/private/company/editCompany.form.validator";
import {companyToDTO} from "@coreModule/utilities/mappers/company/companyMapper.dto";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {mediaService} from "@coreModule/database/schemas/media/media.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {
    deactivateCompanySchema
} from "armonia/src/modules/core/api/company/private/company/deactivateCompany.form.validator";
import {
    DeactivateCompanyFormType
} from "armonia/src/modules/core/api/company/private/company/deactivateCompany.form.type";
import {
    systemMaintenanceNotifyFormSchema
} from "armonia/src/modules/core/api/company/private/company/systemMaintenanceNotify.form.validator";
import {
    SystemMaintenanceNotifyFormType
} from "armonia/src/modules/core/api/company/private/company/systemMaintenanceNotify.form.type";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import Company from "@coreModule/database/schemas/company/company";
import {MediaUploaded, mediaUploadMW} from "@coreModule/utilities/middlewares/mediaUploadMW";
import {getGridFSStorage} from "@coreModule/utilities/gridfs/gridfsStorage";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {schemaSanitizer, SchemaSanitizerMWType} from "@coreModule/utilities/middlewares/schemaSanitizerMW";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import {ActionMessage} from "armonia/src/modules/core/types/shared.types";
import {countryService} from "@coreModule/database/schemas/country/country.service";
import {stateService} from "@coreModule/database/schemas/state/state.service";
import {cityService} from "@coreModule/database/schemas/city/city.service";
import {
    CreateCompanyFormType,
    EditCompanyFormType
} from "armonia/src/modules/core/api/company/private/company/company.schema-def";

/**
 * Company Management Endpoints (Private)
 *
 * This module provides private endpoints for the current company context:
 * - GET "" — Full company details (permission-filtered)
 * - GET /basicInfo — Minimal info (name, description, logo)
 * - PUT "" — Create a new subsidiary company
 * - PATCH "" — Update company (addresses, logo, etc.)
 * - POST /deactivate — Deactivate a subsidiary
 * - POST /activate — Activate a deactivated company
 *
 * All endpoints require authentication. SchemaGuard enforces field-level access.
 *
 * @module modules/core/api/company/company
 */
const router = Router();

async function validateAndMapAddresses(
    addresses: any[],
    companyId: ObjectId,
    ctx: {logger: any; languageCode: string; session: any},
): Promise<any[]> {
    return Promise.all(
        addresses.map(async (addr) => {
            const countryId = new ObjectId(addr.country);
            const stateId   = addr.state ? new ObjectId(addr.state) : undefined;
            const cityId    = new ObjectId(addr.city);

            const cityFilter: Record<string, any> = {_id: cityId, company: companyId, country: countryId};
            if (stateId) cityFilter.state = stateId;

            const [country, state, city] = await Promise.all([
                countryService.findOne({_id: countryId, company: companyId}, ctx),
                stateId
                    ? stateService.findOne({_id: stateId, company: companyId, country: countryId}, ctx)
                    : Promise.resolve(true as any),
                cityService.findOne(cityFilter, ctx),
            ]);

            if (!country) throw apiValidationException("country_not_found", null, null, ctx.languageCode);
            if (stateId && !state) throw apiValidationException("state_not_found", null, null, ctx.languageCode);
            if (!city) throw apiValidationException("city_not_found", null, null, ctx.languageCode);

            return {
                street:     addr.street,
                postalCode: addr.postalCode,
                city:       cityId,
                state:      stateId,
                country:    countryId,
                latitude:   addr.latitude,
                longitude:  addr.longitude,
            };
        }),
    );
}

/**
 * GET /api/company
 *
 * Fetches detailed information about the authenticated user's current company.
 *
 * @route GET /api/company
 * @access Private
 * @returns {Promise<CompanyData>} Company data with populated fields based on user permissions
 *
 * @remarks
 * - Returns company data filtered by user's read permissions
 * - Automatically populates address fields with nested location data
 */
router.get(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    schemaSanitizer({model: "companies", requiredModes: ["read"]}),
    asyncHandler(getCompany)
);
type GetCompanyType = AuthenticatedMWType & SchemaSanitizerMWType;
/**
 * Fetches the current company's information with permission-based field filtering.
 *
 * @param params - Authenticated middleware parameters including company, logger, and user context
 * @returns Company data transformed to DTO format
 */
async function getCompany(params: GetCompanyType): Promise<CompanyData> {
    const { languageCode, company, logger, sanitizedReadFields } = params;

    logger.start(`Fetching company info...`);
    const populate = SchemaGuard.generatePopulate(sanitizedReadFields, Company.schema);

    const companyData = await companyService.findByIdOrThrow(
        company._id,
        { logger, languageCode },
        populate.populate || [],
        populate.select
    );

    logger.finish(`Finished fetching company info!`);

    return companyToDTO(companyData);
}

/**
 * GET /api/company/basicInfo
 *
 * Fetches minimal company information (name, description, logo) for the current company.
 *
 * @route GET /api/company/basicInfo
 * @access Private
 * @returns {Promise<BasicCompanyInfoFormResponseType>} Basic company information
 *
 * @remarks
 * - Lightweight endpoint for quick company info display
 * - Only returns name, description, and logo fields
 */
router.get(
    "/basicInfo",
    authMW("private"),
    rateLimiter({
        windowMs: 60000,
        max: 120
    }),
    asyncHandler(getCompanyBasicInfo)
);
type GetCompanyBasicInfoType = AuthenticatedMWType;
/**
 * Fetches basic company information (name, description, logo).
 *
 * @param params - Authenticated middleware parameters
 * @returns Basic company information object
 * @remarks Logo normalized to string id (handles ObjectId or ref)
 */
async function getCompanyBasicInfo(params: GetCompanyBasicInfoType): Promise<BasicCompanyInfoFormResponseType> {
    const { company, logger, languageCode, actionUserCtx } = params;

    logger.start(`Fetching company basic info...`);

    const sanitizedFields = SchemaGuard.sanitizeFields(Company, {name: {}, description: {}, logo: {}}, "read", actionUserCtx, languageCode);
    const populate = SchemaGuard.generatePopulate(sanitizedFields, Company.schema);

    const companyData = await companyService.findOneOrThrow(
        company._id,
        { logger, languageCode },
        populate.populate,
        populate.select ?? ""
    );

    logger.finish(`Finished fetching company basic info!`);

    const logoValue = companyData.logo ? (companyData.logo as any)._id ? (companyData.logo as any)._id.toString() : (companyData.logo as any).toString() : null;

    return {
        _id: companyData._id.toString(),
        name: companyData.name,
        description: companyData.description,
        logo: logoValue
    };
}

/**
 * PUT /api/company
 *
 * Creates a new subsidiary company with default roles, finance, and user assignment.
 *
 * @route PUT /api/company
 * @access Private
 * @requires Transaction
 * @requires mediaUploadMW (optional, max 1 file, 5MB)
 * @body {CreateCompanyFormType} - Company creation data
 * @returns {Promise<ActionMessage>} Success message
 *
 * @throws {apiValidationException} If company with same VAT already exists
 * @throws {apiValidationException} If parent company doesn't exist
 * @throws {apiValidationException} If admin role not found after creation
 *
 * @remarks
 * - Creates company with default roles via createDefaultRoles()
 * - Assigns creator as admin (ODIN) with full permissions
 * - Creates finance record with maximum currency amounts (999999999.99)
 */
router.put(
    '',
    authMW("private"),
    rateLimiter({
        windowMs: 60000,
        max: 60
    }),
    mediaUploadMW({maxFiles: 1, maxFileSize: 1024 * 1024 * 5}),
    validateFormZod(createCompanyFormSchema),
    transactionHandler(),
    asyncHandler(createNewCompany)
);
type CreateNewCompanyType = TransactionRequiredParams & CreateCompanyFormType & MediaUploaded;
/**
 * Creates a new company with all required setup (roles, finance, user assignment).
 *
 * @param params - Transaction, form, media upload, and authenticated parameters
 * @returns Success message
 * @remarks Validates VAT uniqueness; creates addresses if provided; adds to userInfo.companies/roles/finance
 */
async function createNewCompany(params: CreateNewCompanyType): Promise<ActionMessage> {
    const {name, email, phoneNumber, addresses, description, website, vat, allowedDomains, languageCode, logger, userInfo, session, actionUserCtx, fileIds, company} = params;

    logger.start(`Trying to create new company...`);

    // Check model-level permission first
    SchemaGuard.checkModelPermission(Company, "create", actionUserCtx);

    const existingCompany = await companyService.findOne({ vat }, { session, logger, languageCode });

    if (existingCompany) {
        throw apiValidationException("company_exists_with_same_vat", null, null, languageCode);
    }

    const newCompanyId = new ObjectId();
    await companyService.create(
        {
            _id: newCompanyId,
            name,
            email,
            phoneNumber,
            description,
            logo: !!fileIds && !!fileIds[0] ? fileIds[0] : null,
            website,
            vat,
            company: company._id,
            allowedDomains: allowedDomains?.map((domain: string) => domain.trim()).filter((domain: string) => domain !== "") || ["none.none.com"],
            addresses: await validateAndMapAddresses(addresses, newCompanyId, {languageCode, session, logger}),
            parentCompany: company._id
        } as any,
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    logger.finish(`Finished creating new company!`);

    return { message: "New company successfully created" };
}

/**
 * PATCH /api/company
 *
 * Updates company information including basic fields, addresses, and logo.
 *
 * @route PATCH /api/company
 * @access Private
 * @requires Transaction
 * @requires mediaUploadMW (optional, max 1 file, 5MB)
 * @body {EditCompanyFormType} - Company update data
 * @returns {Promise<ActionMessage>} Success message
 *
 * @remarks
 * - Supports updating: name, email, phone, description, website, VAT, parentCompany, allowedDomains
 * - Can add, modify, or delete addresses in a single operation
 * - Logo upload replaces existing logo (old logo is deleted)
 */
router.patch(
    '',
    authMW("private"),
    rateLimiter({
        windowMs: 60000,
        max: 60
    }),
    mediaUploadMW({maxFiles: 1, maxFileSize: 1024 * 1024 * 5}),
    schemaSanitizer({model: "companies", requiredModes: ["write"]}),
    validateFormZod(editCompanyFormSchema),
    transactionHandler(),
    asyncHandler(updateCompany)
);
type UpdateCompanyType = TransactionRequiredParams & EditCompanyFormType & MediaUploaded & SchemaSanitizerMWType;
/**
 * Updates company information with support for addresses and media.
 *
 * @param params - Transaction, form, media upload, and authenticated parameters
 * @returns Success message
 */
async function updateCompany(params: UpdateCompanyType): Promise<ActionMessage> {
    const {name, email, phoneNumber, addresses, description, parentCompany, website, vat, allowedDomains, languageCode, logger, session, company, actionUserCtx, actionUserInfo, fileIds, sanitizedWriteFields} = params;

    logger.start(`Trying to update company with id: [${company._id.toString()}]...`);

    const existingCompany = await companyService.findByIdOrThrow(
        company._id,
        { session, logger, languageCode }
    );

    if (parentCompany && sanitizedWriteFields.parentCompany) {
        const parentCompanyInfo = await companyService.findById(
            parentCompany,
            { session, logger, languageCode }
        );

        if (!parentCompanyInfo) {
            throw apiValidationException("parent_company_does_not_exist", null, null, languageCode);
        }
        existingCompany.parentCompany = parentCompanyInfo;
    }

    let deleteThis: ObjectId | null = null;
    if (name && sanitizedWriteFields.name) existingCompany.name = name;
    if (email && sanitizedWriteFields.email) existingCompany.email = email;
    if (phoneNumber && sanitizedWriteFields.phoneNumber) existingCompany.phoneNumber = phoneNumber;
    if (description && sanitizedWriteFields.description) existingCompany.description = description;
    if (!!fileIds && !!fileIds[0] && sanitizedWriteFields.logo) {
        deleteThis = existingCompany.logo;
        existingCompany.logo = new ObjectId(fileIds[0])
    }
    if (website && sanitizedWriteFields.website) existingCompany.website = website;
    if (vat && sanitizedWriteFields.vat) existingCompany.vat = vat;
    if (allowedDomains && sanitizedWriteFields.allowedDomains) {
        existingCompany.allowedDomains = allowedDomains
            .map((domain: string) => domain.trim())
            .filter((domain: string) => domain !== "") || ["none.none.com"];
    }

    if (sanitizedWriteFields.addresses) {
        if( addresses.length > 0 ){
            existingCompany.addresses = await validateAndMapAddresses(addresses, company._id, {languageCode, session, logger});
        }
        else if( addresses.length === 0 ){
            existingCompany.addresses = [];
        }
    }

    // Delete old media before saving company to maintain transaction consistency
    if( deleteThis ){
        try {
            const media = await mediaService.findById(deleteThis, {logger, languageCode, session});
            const gridfs = getGridFSStorage(languageCode, 'media', logger);
            await gridfs.deleteFile(media.fileId.toString());
            await mediaService.deleteById(deleteThis, {logger, languageCode, session, hard: true});

        } catch (error: any) {
            logger.err?.(`Failed to delete old logo: ${error.message}`, error);
            // Continue with save - old logo will remain but new one is set
        }
    }

    existingCompany.$locals = existingCompany.$locals || {};
    existingCompany.$locals.auditUserId = new ObjectId(actionUserCtx.userId);
    await existingCompany.save({session});

    const activeMembers = await userService.find(
        {
            companies: company._id,
            "roles.company": company._id,
            "roles.active": "active"
        },
        { session, logger, languageCode },
        null,
        "_id"
    );
    const memberIds = activeMembers.map((u) => u._id.toString()).filter((id) => id !== actionUserCtx.userId);
    const updatedByUsername =`${actionUserInfo.name || ""} ${actionUserInfo.surname || ""}`.trim() || actionUserInfo.username;
    if (memberIds.length > 0) {
        emitNotificationEvent(
            NotificationEventCodes.COMPANY_UPDATED, 
            {
                receiverIds: memberIds,
                payload: {
                    companyId: company._id.toString(),
                    companyName: existingCompany.name,
                    updatedByUserId: actionUserCtx.userId,
                    updatedByUsername,
                    languageCode
                },
                session
            }
        );
    }

    logger.finish(`Finished update company!`);

    return { message: "Company successfully updated" };
}

/**
 * POST /api/company/system-maintenance-notify
 *
 * Broadcasts a system maintenance notification to all active company members. Company admins only.
 */
router.post(
    "/system-maintenance-notify",
    authMW("private"),
    rateLimiter({
        windowMs: 60000,
        max: 10
    }),
    validateFormZod(systemMaintenanceNotifyFormSchema),
    transactionHandler(),
    asyncHandler(notifySystemMaintenance)
);
type NotifySystemMaintenanceType = TransactionRequiredParams & SystemMaintenanceNotifyFormType;
/**
 * Notifies active company members about scheduled maintenance (admin only).
 */
async function notifySystemMaintenance(params: NotifySystemMaintenanceType): Promise<ActionMessage> {
    const { logger, languageCode, session, company, actionUserInfo, message, startsAt, endsAt } = params;

    logger.start(`Broadcasting system maintenance notification for company [${company._id.toString()}]...`);

    const isAdmin = await actionUserInfo.isAdmin(company._id);
    if (!isAdmin) {
        throw apiValidationException("user_permissions_not_sufficient", null, null, languageCode);
    }

    const maintenanceMembers = await userService.find(
        {
            companies: company._id,
            "roles.company": company._id,
            "roles.active": "active"
        },
        { session, logger, languageCode },
        null,
        "_id"
    );
    const receiverIds = maintenanceMembers.map((u) => u._id.toString());
    if (receiverIds.length > 0) {
        emitNotificationEvent(
            NotificationEventCodes.SYSTEM_MAINTENANCE, 
            {
                receiverIds,
                payload: {
                    companyId: company._id.toString(),
                    message,
                    startsAt,
                    endsAt,
                    languageCode
                },
                session
            }
        );
    }

    logger.finish(`System maintenance notification broadcast complete`);
    return { message: "Maintenance notification sent to company members" };
}

/**
 * POST /api/company/deactivate
 *
 * Deactivates a subsidiary company. Requires company name confirmation for safety.
 *
 * @route POST /api/company/deactivate
 * @access Private
 * @requires Transaction
 * @body {DeactivateCompanyFormType} - Must include name field matching company name
 * @returns {Promise<ActionMessage>} Success message
 *
 * @throws {apiValidationException} If company name doesn't match
 * @throws {apiValidationException} If attempting to deactivate main company (no parent)
 */
router.post(
    "/deactivate",
    authMW("private"),
    rateLimiter({
        windowMs: 60000,
        max: 60
    }),
    validateFormZod(deactivateCompanySchema),
    transactionHandler(),
    asyncHandler(deactivateCompany)
);
type DeactivateCompanyType = TransactionRequiredParams & DeactivateCompanyFormType;
/**
 * Deactivates a company after validating name and parent company existence.
 *
 * @param params - Transaction and form parameters including company name
 * @returns Success message
 * @remarks Only subsidiary companies (with parentCompany) can be deactivated
 */
async function deactivateCompany(params: DeactivateCompanyType): Promise<ActionMessage> {
    const { logger, languageCode, name, company, actionUserCtx, session } = params;

    logger.start(`Trying to deactivate company...`);
    SchemaGuard.sanitizeFields(Company, {isActive: {}}, "write", actionUserCtx, languageCode);

    let companyData = await companyService.findByIdOrThrow(company._id, { logger, languageCode, session }, "", "_id name company");
    if( name !== companyData.name ){
        throw apiValidationException("company_name_does_not_match", null, null, languageCode);
    }
    if( companyData.company.equals(companyData._id) ){
        throw apiValidationException("cannot_deactivate_main_company", null, null, languageCode);
    }

    await companyService.updateByIdOrThrow(
        company._id,
        { isActive: false },
        { logger, languageCode, session, auditUserId: actionUserCtx.userId },
    )

    logger.finish(`Finished deactivating company!`);

    return {
        message: "Company successfully deactivated!"
    }
}

/**
 * POST /api/company/activate
 *
 * Activates a previously deactivated company.
 *
 * @route POST /api/company/activate
 * @access Private
 * @requires Transaction
 * @returns {Promise<ActionMessage>} Success message
 *
 * @remarks
 * - Requires write permission for isActive field
 */
router.post(
    "/activate",
    authMW("private"),
    rateLimiter({
        windowMs: 60000,
        max: 60
    }),
    transactionHandler(),
    asyncHandler(activateCompany)
);
type ActivateCompanyType = TransactionRequiredParams;
/**
 * Activates a company by setting isActive to true.
 *
 * @param params - Transaction and authenticated parameters
 * @returns Success message
 */
async function activateCompany(params: ActivateCompanyType): Promise<ActionMessage> {
    const { logger, languageCode, company, actionUserCtx, session } = params;

    logger.start(`Trying to activate company...`);
    SchemaGuard.sanitizeFields(Company, {isActive: {}}, "write", actionUserCtx, languageCode);

    await companyService.updateByIdOrThrow(
        company._id,
        { isActive: true },
        { logger, languageCode, session, auditUserId: actionUserCtx.userId },
    )

    logger.finish(`Finished activating company!`);

    return {
        message: "Company successfully activated!"
    }
}

export const basePath = '/api/company';
export { router };
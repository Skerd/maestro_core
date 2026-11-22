import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import type {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import authMW from "@coreModule/utilities/middlewares/authMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {type MediaUploaded, mediaUploadMW} from "@coreModule/utilities/middlewares/mediaUploadMW";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {selfServeBusinessFormSchema} from "armonia/src/modules/core/api/portal/private/business/selfServeBusiness.form.validator";
import {
    SELF_SERVE_BUSINESS_LIMIT,
    type SelfServeBusinessFormType,
} from "armonia/src/modules/core/api/portal/private/business/selfServeBusiness.schema-def";
import type {SelfServeBusinessCreatedResponse} from "armonia/src/modules/core/api/portal/private/business/selfServeBusiness.dto";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {createCompany} from "@coreModule/domain/company/createCompany";
import {findSelfServeBusinessType} from "@coreModule/domain/company/selfServeBusinessTypes";
import {companySiteUrl, findPlatformCompany} from "@coreModule/utilities/marketing/portalCompanies";
import {clientHostFor} from "@coreModule/environment";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {notifyCompanySignedUp} from "@coreModule/domain/company/companySignupNotices";

/**
 * Self-serve business sign-up (D178): a signed-in person creates their own company from the portal. It belongs to the
 * platform company, starts with the modules of the business type they picked, and its own site is live at once; the
 * portal apex lists it only after the platform approves it (`portalApproval`). The person becomes its admin.
 *
 * Signing in already required a verified email (an activated account or a Google/Apple sign-in).
 */
export const basePath = "/api/portal/business";
export const router = Router();

router.put(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 10}),
    mediaUploadMW({maxFiles: 1, maxFileSize: 1024 * 1024 * 5}),
    validateFormZod(selfServeBusinessFormSchema),
    transactionHandler(),
    asyncHandler(createSelfServeBusiness),
);

type CreateSelfServeBusinessParams = TransactionRequiredParams & SelfServeBusinessFormType & MediaUploaded;

async function createSelfServeBusiness(params: CreateSelfServeBusinessParams): Promise<SelfServeBusinessCreatedResponse> {
    const {businessType, name, phoneNumber, vat, siteSlug, address, languageCode, logger, session, actionUserCtx, fileIds, company} = params;

    const type = findSelfServeBusinessType(businessType);
    if (!type) {
        throw apiValidationException("business_type_not_offered", "businessType", null, languageCode);
    }
    const creator = new ObjectId(actionUserCtx.userId);
    // Companies the platform created for someone carry no approval record, so they do not count.
    const alreadyCreated = await companyService.count({createdBy: creator, portalApproval: {$exists: true}}, {session, logger, languageCode});
    if (alreadyCreated >= SELF_SERVE_BUSINESS_LIMIT) {
        throw apiValidationException("self_serve_business_limit_reached", null, null, languageCode, [String(SELF_SERVE_BUSINESS_LIMIT)]);
    }

    logger.start(`Creating self-serve business '${name}' (${type.key})...`);
    const platform = await findPlatformCompany(languageCode);
    const panelUrl = clientHostFor("core") || undefined;
    const business = await createCompany(
        {
            name,
            phoneNumber,
            vat,
            siteSlug,
            addresses: [address],
            // A panel sign-in lands in the company that lists the panel's host before one that accepts any (D178).
            allowedDomains: panelUrl ? [new URL(panelUrl).hostname] : [],
            logo: fileIds?.[0] ?? null,
            parentCompanyId: platform._id,
            uploadedInCompanyId: company._id,
            modules: type.modules,
            portalApproval: {status: "pending"},
        },
        {session, logger, languageCode, auditUserId: creator},
    );
    const onCreated = type.onCreated;
    if (onCreated) {
        await withTenant(business._id, () => onCreated({company: business, session, logger, languageCode}));
    }
    // The platform's admins decide whether the apex lists it.
    await notifyCompanySignedUp({_id: business._id, name: business.name}, {languageCode, session});
    logger.finish(`Created self-serve business '${name}' (${String(business._id)})`);

    return {
        data: {
            companyId: String(business._id),
            name: business.name,
            siteSlug: business.siteSlug ?? "",
            siteUrl: companySiteUrl({_id: business._id, siteSlug: business.siteSlug}, "/"),
            ...(panelUrl ? {panelUrl} : {}),
        },
    };
}

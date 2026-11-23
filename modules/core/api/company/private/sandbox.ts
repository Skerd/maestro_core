import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import type {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import authMW, {type AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {validateDeleteForm} from "armonia/src/modules/core/utilities/zod/shared.validator";
import {
    createSandboxFormSchema,
    type CreateSandboxFormType,
} from "armonia/src/modules/core/api/company/private/sandbox/sandbox.form.validator";
import type {SandboxStateResponse} from "armonia/src/modules/core/api/company/private/sandbox/sandbox.dto";
import type {ActionMessage} from "armonia/src/modules/core/types/shared.types";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {nestedEntityToRef} from "@coreModule/utilities/mappers/common.mapper";
import {
    createSandboxCompany,
    deleteSandboxCompany,
    findSandboxOf,
    sandboxSeedStatus,
    sandboxToDTO,
} from "@coreModule/domain/company/sandboxCompany";

/**
 * "Try with sample data" (D178, P23.4), for the admins of the company the caller works in:
 * - GET    "" — the company's sample company and how far its demo data is (or, inside a sample company, its parent)
 * - PUT    "" — make the sample company; its demo data is seeded in the background
 * - DELETE "" — delete a sample company for good: by an admin of its parent, or of the sample company itself
 *
 * @module modules/core/api/company/sandbox
 */
export const basePath = "/api/company/sandbox";
export const router = Router();

function assertAdmin(params: AuthenticatedMWType): void {
    if (!params.actionUserCtx.isAdmin) {
        throw apiValidationException("user_permissions_not_sufficient", "", null, params.languageCode);
    }
}

router.get(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(getSandboxState),
);

async function getSandboxState(params: AuthenticatedMWType): Promise<SandboxStateResponse> {
    const {company, logger, languageCode} = params;
    assertAdmin(params);
    const ctx = {logger, languageCode};
    const current = await companyService.findByIdOrThrow(company._id, ctx, undefined, "name isSandbox sandboxSeed parentCompany");
    if (current.isSandbox) {
        const parentId = nestedEntityToRef(current.parentCompany);
        const parent = parentId ? await companyService.findById(parentId, ctx, undefined, "name") : null;
        return {
            ...(parent ? {parent: {_id: String(parent._id), name: parent.name}} : {}),
            sandbox: sandboxToDTO(current),
        };
    }
    const sandbox = await findSandboxOf(company._id, ctx);
    return sandbox ? {sandbox: sandboxToDTO(sandbox)} : {};
}

router.put(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 10}),
    validateFormZod(createSandboxFormSchema),
    transactionHandler(),
    asyncHandler(createSandbox),
);

async function createSandbox(params: TransactionRequiredParams & CreateSandboxFormType): Promise<SandboxStateResponse> {
    const {name, company, actionUserCtx, session, logger, languageCode} = params;
    assertAdmin(params);
    const ctx = {session, logger, languageCode};
    const parent = await companyService.findByIdOrThrow(company._id, ctx, undefined, "name siteSlug timezone modules isSandbox");
    if (parent.isSandbox) {
        throw apiValidationException("company_sandbox_of_sandbox", "", null, languageCode);
    }
    if (await findSandboxOf(parent._id, ctx)) {
        throw apiValidationException("company_sandbox_exists", "", null, languageCode);
    }
    const sandbox = await createSandboxCompany(parent, name, {...ctx, auditUserId: actionUserCtx.userId});
    logger.info(`Sample company '${sandbox.name}' (${String(sandbox._id)}) made for '${parent.name}'; its demo data is seeded after commit`);
    return {sandbox: sandboxToDTO(sandbox)};
}

router.delete(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 10}),
    validateFormZod(validateDeleteForm),
    transactionHandler(),
    asyncHandler(deleteSandbox),
);

async function deleteSandbox(params: TransactionRequiredParams & {_id: string}): Promise<ActionMessage> {
    const {company, session, logger, languageCode} = params;
    assertAdmin(params);
    const sandboxId = new ObjectId(params._id);
    const target = await companyService.findById(sandboxId, {session, logger, languageCode}, undefined, "isSandbox parentCompany sandboxSeed");
    if (target?.isSandbox !== true) {
        throw apiValidationException("company_not_sandbox", "", null, languageCode);
    }
    // An admin of the company it belongs to, or of the sample company itself.
    const own = sandboxId.equals(company._id) || nestedEntityToRef(target.parentCompany)?.equals(company._id) === true;
    if (!own) {
        throw apiValidationException("user_permissions_not_sufficient", "", null, languageCode);
    }
    // Its seeders are still writing: rows made after the delete would be left behind.
    if (sandboxSeedStatus(target.sandboxSeed) === "preparing") {
        throw apiValidationException("company_sandbox_preparing", "", null, languageCode);
    }
    await deleteSandboxCompany(sandboxId, {session, logger, languageCode});
    return {message: "Sample company deleted"};
}

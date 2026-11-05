import {Router} from "express";
import {Types} from "mongoose";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import authMW from "@coreModule/utilities/middlewares/authMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {erasePersonFormSchema, type ErasePersonFormType} from "armonia/src/modules/core/api/company/private/privacy/erasePerson.form.validator";
import type {ErasePersonResponseDto} from "armonia/src/modules/core/api/company/private/privacy/erasePerson.dto";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {erasePersonInCompany, erasureSubject, personErasureModules} from "@coreModule/utilities/erasure/personErasure";

const router = Router();

/**
 * POST /api/privacy/erasePerson
 *
 * A company admin erases one person, found by email, from this company's records (D57, SEC-06). `preview` only counts
 * what would change. The person's login account and other companies' records are left alone.
 */
router.post(
    "/erasePerson",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 10}),
    validateFormZod(erasePersonFormSchema),
    transactionHandler(),
    asyncHandler(erasePerson),
);

async function erasePerson(params: TransactionRequiredParams & ErasePersonFormType): Promise<ErasePersonResponseDto> {
    const {email, preview, company, actionUserCtx, session, logger, languageCode} = params;
    if (!actionUserCtx.isAdmin) throw apiValidationException("user_permissions_not_sufficient", "", null, languageCode);
    // Same rule as the session's `canErasePeople`: only a company with a module that can erase a person.
    const erasable = await personErasureModules();
    if (!erasable.some((name) => (actionUserCtx.modules ?? []).includes(name))) {
        throw apiValidationException("user_permissions_not_sufficient", "", null, languageCode);
    }

    const normalized = email.trim().toLowerCase();
    // Their portal account, if they have one, links records that no longer carry the email. A user's email is its
    // `username`; an email names at most one account, so more would mean the lookup matched other people.
    const accounts = await userService.find({username: normalized}, {session, logger, languageCode}, undefined, "_id", undefined, 2);
    if (accounts.length > 1) throw new Error(`Erasure lookup for one email matched ${accounts.length} accounts`);
    const subject = erasureSubject({emails: [normalized], accountIds: accounts.map((account) => String(account._id))});
    const counts = await erasePersonInCompany({companyId: company._id, subject, preview, session, logger, actorId: new Types.ObjectId(actionUserCtx.userId)});
    return {preview, counts};
}

export const basePath = "/api/privacy";
export {router};

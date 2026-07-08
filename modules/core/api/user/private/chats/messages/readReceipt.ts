import {Router} from "express";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequired} from "@coreModule/utilities/middlewares/transactionUtils";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {applyMessageReceipts} from "@coreModule/domain/messages/applyMessageReceipts";
import {
    MarkMessageReceiptFormType
} from "armonia/src/modules/core/api/user/private/chats/messages/actions/markMessageReceipt.form.type";
import {
    markMessageReceiptFormSchema
} from "armonia/src/modules/core/api/user/private/chats/messages/actions/markMessageReceipt.form.validator";
import {
    MarkMessageReceiptFormResponseType
} from "armonia/src/modules/core/api/user/private/chats/messages/actions/markMessageReceipt.form.response.type";

const router = Router();

/**
 * PATCH /api/user/chats/messages/readReceipt
 *
 * Records delivery or read receipts for messages visible to the caller in the channel.
 *
 * @module api/core/user/private/chats/messages/readReceipt
 */
router.patch(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 120}),
    transactionHandler(),
    validateFormZod(markMessageReceiptFormSchema),
    asyncHandler(patchMessageReceipts)
);

type PatchReceiptsType = TransactionRequired & MarkMessageReceiptFormType & AuthenticatedMWType;

async function patchMessageReceipts(params: PatchReceiptsType): Promise<MarkMessageReceiptFormResponseType> {
    const {
        channelId,
        messageIds,
        kind,
        session,
        logger,
        languageCode,
        userInfo,
        company,
        actionUserCtx
    } = params;

    logger.start(`Mark message receipts (${kind}) for ${messageIds.length} id(s) in channel ${channelId}`);

    const {updatedMessageIds} = await applyMessageReceipts({
        readerUserId: userInfo._id,
        channelId,
        companyId: company._id,
        messageIds,
        kind,
        session,
        logger,
        languageCode,
        auditUserId: actionUserCtx.userId
    });

    logger.finish(`Updated receipts on ${updatedMessageIds.length} message(s)`);
    return {updatedMessageIds};
}

export {router};

import {ObjectId} from "mongodb";
import {action} from "@coreModule/api/actionDecorator";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {COLLECTED_DATA} from "@coreModule/database/collections";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import MessagingProvider from "@coreModule/database/schemas/messagingProvider/messagingProvider";
import {messagingProviderService} from "@coreModule/database/schemas/messagingProvider/messagingProvider.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {messagingProviderToDTO} from "@coreModule/utilities/mappers/messagingProvider/messagingProviderMapper.dto";
import type {MessagingProvider} from "armonia/src/modules/core/api/auxiliary/private/messagingProvider/messagingProvider.dto";
import type {TestMessagingProviderConnectionResponse} from "armonia/src/modules/core/api/auxiliary/private/messagingProvider/messagingProvider.dto";
import {testMessagingProviderConnection} from "@coreModule/utilities/messaging/messagingDispatchService";
import {ServerError} from "armonia/src/modules/core/types";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";

export class MessagingProviderActions {
    @action({
        auth: "private",
        rateLimit: {windowMs: 60000, max: 5},
        schema: validateSingleForm,
    })
    async testConnection(params: Record<string, any>): Promise<TestMessagingProviderConnectionResponse> {
        const {logger, languageCode, company, actionUserCtx, session, _id} = params;

        let testPhone = params.testPhone?.trim();
        if (!testPhone) {
            const actionUser = await userService.findById(
                actionUserCtx.userId,
                {logger, languageCode},
                undefined,
                "phoneNumber",
            );
            testPhone = actionUser?.phoneNumber?.trim();
        }
        if (!testPhone) {
            throw apiValidationException("test_phone_required", "testPhone", null, languageCode);
        }

        const doc = await messagingProviderService.findOneOrThrow(
            {_id: new ObjectId(_id), company: company._id},
            {logger, languageCode, session},
        );

        const authTokenOverride = params.authToken?.trim() ? params.authToken : undefined;

        try {
            const result = await testMessagingProviderConnection(doc, testPhone, languageCode, authTokenOverride);

            await messagingProviderService.updateById(
                doc._id,
                {
                    lastTestedAt: new Date(),
                    lastTestStatus: "ok",
                    lastTestMessage: result.message,
                },
                {session, logger, languageCode, auditUserId: actionUserCtx.userId},
            );

            return result;
        } catch (err) {
            const failMessage = err instanceof ServerError
                ? err.message
                : err instanceof Error
                    ? err.message
                    : "Messaging connection test failed";
            await messagingProviderService.updateById(
                doc._id,
                {
                    lastTestedAt: new Date(),
                    lastTestStatus: "failed",
                    lastTestMessage: failMessage.slice(0, 500),
                },
                {session, logger, languageCode, auditUserId: actionUserCtx.userId},
            );
            throw err;
        }
    }

    @action({
        auth: "private",
        rateLimit: {windowMs: 60000, max: 30},
        schema: validateSingleForm,
        transaction: true,
    })
    async activate(params: Record<string, any>): Promise<MessagingProvider> {
        return setActiveState(params, true);
    }

    @action({
        auth: "private",
        rateLimit: {windowMs: 60000, max: 30},
        schema: validateSingleForm,
        transaction: true,
    })
    async deactivate(params: Record<string, any>): Promise<MessagingProvider> {
        return setActiveState(params, false);
    }
}

async function setActiveState(params: Record<string, any>, active: boolean): Promise<MessagingProvider> {
    const {logger, languageCode, session, company, actionUserCtx, _id} = params;

    const writeFields = SchemaGuard.sanitizeFields(
        MessagingProvider,
        COLLECTED_DATA.messagingproviders.writeFields,
        "write",
        actionUserCtx,
        languageCode,
    );
    if (!writeFields.active) {
        throw apiValidationException("user_permissions_not_sufficient", null, null, languageCode);
    }

    const existing = await messagingProviderService.findOneOrThrow(
        {_id: new ObjectId(_id), company: company._id},
        {session, logger, languageCode},
    );

    if (existing.active === active) {
        return messagingProviderToDTO(existing);
    }

    const updated = await messagingProviderService.updateByIdOrThrow(
        existing._id,
        {active},
        {session, logger, languageCode, auditUserId: actionUserCtx.userId},
    );

    return messagingProviderToDTO(updated);
}

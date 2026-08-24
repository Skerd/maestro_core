import {ObjectId} from "mongodb";
import {action} from "@coreModule/api/actionDecorator";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {COLLECTED_DATA} from "@coreModule/database/collections";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import SmtpServer from "@coreModule/database/schemas/smtpServer/smtpServer";
import {smtpServerService} from "@coreModule/database/schemas/smtpServer/smtpServer.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {smtpServerToDTO} from "@coreModule/utilities/mappers/smtpServer/smtpServerMapper.dto";
import {invalidateCompanyMailCache, smtpServerToConnectionConfig, testSmtpConnection,} from "@coreModule/utilities/emails/mailDeliveryService";
import type {SmtpServer as SmtpServerDTO, TestSmtpConnectionResponse} from "armonia/src/modules/core/api/auxiliary/private/smtpServer/smtpServer.dto";
import type {SmtpAuthType, SmtpEncryptionType} from "armonia/src/modules/core/api/auxiliary/private/smtpServer/smtpServer.constants";
import {ServerError} from "armonia/src/modules/core/types";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";

export class SmtpServerActions {
    @action({
        auth: "private",
        rateLimit: {windowMs: 60000, max: 5},
        schema: validateSingleForm,
    })
    async testConnection(params: Record<string, any>): Promise<TestSmtpConnectionResponse> {
        const {logger, languageCode, company, actionUserCtx, session, _id} = params;

        const smtpServer = await smtpServerService.findOneOrThrow(
            {
                _id: new ObjectId(_id),
                company: company._id
            },
            {logger, languageCode, session},
        );
        const config = smtpServerToConnectionConfig(smtpServer);

        const actionUser = await userService.findById(actionUserCtx.userId, {logger, languageCode}, undefined, "username");
        if (!actionUser.username) {
            throw apiValidationException("test_email_required", "testEmail", null, languageCode);
        }

        try {
            const result = await testSmtpConnection(
                config,
                actionUser?.username?.trim(),
                smtpServer.name,
                languageCode
            );
            const lastTest: TestSmtpConnectionResponse = {
                lastTestedAt: new Date(),
                lastTestStatus: "ok",
                lastTestMessage: result.message
            };
            await smtpServerService.updateById(
                smtpServer._id,
                lastTest,
                {session, logger, languageCode, auditUserId: actionUserCtx.userId},
            );
            invalidateCompanyMailCache(company._id);
            return lastTest;

        } catch (err) {
            const failMessage = err instanceof ServerError ? err.message : "SMTP connection test failed";
            await smtpServerService.updateById(
                smtpServer._id,
                {
                    lastTestedAt: new Date(),
                    lastTestStatus: "failed",
                    lastTestMessage: failMessage.slice(0, 500),
                },
                {session, logger, languageCode, auditUserId: actionUserCtx.userId},
            );
            invalidateCompanyMailCache(company._id);
            throw err;
        }
    }

    @action({
        auth: "private",
        rateLimit: {windowMs: 60000, max: 30},
        schema: validateSingleForm,
        transaction: true,
    })
    async activate(params: Record<string, any>): Promise<SmtpServerDTO> {
        return setActiveState(params, true);
    }

    @action({
        auth: "private",
        rateLimit: {windowMs: 60000, max: 30},
        schema: validateSingleForm,
        transaction: true,
    })
    async deactivate(params: Record<string, any>): Promise<SmtpServerDTO> {
        return setActiveState(params, false);
    }
}

async function setActiveState(params: Record<string, any>, active: boolean): Promise<SmtpServerDTO> {
    const {logger, languageCode, session, company, actionUserCtx, _id} = params;

    const writeFields = SchemaGuard.sanitizeFields(
        SmtpServer,
        COLLECTED_DATA.smtpservers.writeFields,
        "write",
        actionUserCtx,
        languageCode,
    );
    if (!writeFields.active) {
        throw apiValidationException("user_permissions_not_sufficient", null, null, languageCode);
    }

    const existing = await smtpServerService.findOneOrThrow(
        {_id: new ObjectId(_id), company: company._id},
        {session, logger, languageCode},
    );

    if (existing.active === active) {
        return smtpServerToDTO(existing);
    }

    const updated = await smtpServerService.updateByIdOrThrow(
        existing._id,
        {active},
        {session, logger, languageCode, auditUserId: actionUserCtx.userId},
    );

    invalidateCompanyMailCache(company._id);
    return smtpServerToDTO(updated);
}

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

        let testEmail = params.testEmail?.trim();
        if (!testEmail) {
            const actionUser = await userService.findById(actionUserCtx.userId, {logger, languageCode}, undefined, "username");
            testEmail = actionUser?.username?.trim();
        }
        if (!testEmail) {
            throw apiValidationException("test_email_required", "testEmail", null, languageCode);
        }

        let config: ReturnType<typeof smtpServerToConnectionConfig>;
        let serverId: ObjectId | undefined;
        let serverName: string | undefined;

        if (_id) {
            const doc = await smtpServerService.findOneOrThrow(
                {_id: new ObjectId(_id), company: company._id},
                {logger, languageCode, session},
            );
            serverId = doc._id;
            serverName = doc.name;
            const passwordOverride = params.password?.trim() ? params.password : undefined;
            config = smtpServerToConnectionConfig(doc, passwordOverride);
        } else {
            const host = params.host?.trim();
            const port = Number(params.port);
            const encryption = params.encryption as SmtpEncryptionType;
            const authType = params.authType as SmtpAuthType;
            if (!host || !port || !encryption || !authType) {
                throw apiValidationException("smtp_test_fields_required", "", null, languageCode);
            }
            config = {
                host,
                port,
                encryption,
                authType,
                username: params.username?.trim() || undefined,
                password: params.password?.trim() || undefined,
                fromEmail: params.fromEmail?.trim() || testEmail,
                fromName: params.fromName?.trim() || undefined,
            };
            serverName = params.name?.trim();
        }

        try {
            const result = await testSmtpConnection(config, testEmail, serverName, languageCode);

            if (serverId) {
                await smtpServerService.updateById(
                    serverId,
                    {
                        lastTestedAt: new Date(),
                        lastTestStatus: "ok",
                        lastTestMessage: result.message,
                    },
                    {session, logger, languageCode, auditUserId: actionUserCtx.userId},
                );
                invalidateCompanyMailCache(company._id);
            }

            return result;
        } catch (err) {
            if (serverId) {
                const failMessage = err instanceof ServerError ? err.message : "SMTP connection test failed";
                await smtpServerService.updateById(
                    serverId,
                    {
                        lastTestedAt: new Date(),
                        lastTestStatus: "failed",
                        lastTestMessage: failMessage.slice(0, 500),
                    },
                    {session, logger, languageCode, auditUserId: actionUserCtx.userId},
                );
                invalidateCompanyMailCache(company._id);
            }
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

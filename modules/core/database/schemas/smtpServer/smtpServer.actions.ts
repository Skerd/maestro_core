import {ObjectId} from "mongodb";
import {action} from "@coreModule/api/actionDecorator";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {smtpServerService} from "@coreModule/database/schemas/smtpServer/smtpServer.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {invalidateCompanyMailCache, smtpServerToConnectionConfig, testSmtpConnection,} from "@coreModule/utilities/emails/mailDeliveryService";
import type {TestSmtpConnectionResponse} from "armonia/src/modules/core/api/auxiliary/private/smtpServer/smtpServer.dto";
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
}

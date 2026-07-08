import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import SmtpServer from "@coreModule/database/schemas/smtpServer/smtpServer";
import {smtpServerService} from "@coreModule/database/schemas/smtpServer/smtpServer.service";
import {SmtpServerActions} from "@coreModule/database/schemas/smtpServer/smtpServer.actions";
import {smtpServersToDTO, smtpServerToDTO} from "@coreModule/utilities/mappers/smtpServer/smtpServerMapper.dto";
import {smtpServersToSelect} from "@coreModule/utilities/mappers/smtpServer/smtpServerMapper.select";
import {
    encryptSmtpPassword,
    invalidateCompanyMailCache,
} from "@coreModule/utilities/emails/mailDeliveryService";
import {createSmtpServerFormSchema} from "armonia/src/modules/core/api/auxiliary/private/smtpServer/createSmtpServer.form.validator";
import {editSmtpServerFormSchema} from "armonia/src/modules/core/api/auxiliary/private/smtpServer/editSmtpServer.form.validator";
import type {SmtpAuthType, SmtpEncryptionType} from "armonia/src/modules/core/api/auxiliary/private/smtpServer/smtpServer.constants";

export const {router} = createCrudRouter({
    collectionName: "smtpservers",
    model: SmtpServer,
    service: smtpServerService,
    createSchema: createSmtpServerFormSchema,
    editSchema: editSmtpServerFormSchema,
    toDTO: smtpServerToDTO,
    toDTOArray: smtpServersToDTO,
    toSelect: smtpServersToSelect,
    defaultSort: {sequence: 1, name: 1},
    entityName: "SmtpServer",
    actions: SmtpServerActions,
    buildCreateData: async ({name, sequence, active, host, port, encryption, authType, username, password, fromEmail, fromName, replyTo,}) => ({
        name: name.trim(),
        sequence: sequence ?? 10,
        active: active ?? true,
        host: host.trim(),
        port,
        encryption: encryption as SmtpEncryptionType,
        authType: authType as SmtpAuthType,
        username: authType === "login" ? username?.trim() : undefined,
        passwordEncrypted: authType === "login" && password?.trim() ? encryptSmtpPassword(password.trim()) : undefined,
        fromEmail: fromEmail.trim().toLowerCase(),
        fromName: fromName?.trim() || "",
        replyTo: replyTo ? replyTo.trim() : undefined
    }),
    buildUpdateData: async ({name, sequence, active, host, port, encryption, authType, username, password, fromEmail, fromName, replyTo}, w) => {
        const update: Record<string, unknown> = {};
        if (name !== undefined && w.name) update.name = name.trim();
        if (sequence !== undefined && w.sequence) update.sequence = sequence;
        if (active !== undefined && w.active) update.active = active;
        if (host !== undefined && w.host) update.host = host.trim();
        if (port !== undefined && w.port) update.port = port;
        if (encryption !== undefined && w.encryption) update.encryption = encryption;
        if (authType !== undefined && w.authType) update.authType = authType;
        if (username !== undefined && w.username) {
            update.username = authType === "login" ? username?.trim() || null : null;
        }
        if (password !== undefined && password?.trim() && (w.username || w.authType)) {
            update.passwordEncrypted = encryptSmtpPassword(password.trim());
        }
        if (fromEmail !== undefined && w.fromEmail) update.fromEmail = fromEmail.trim().toLowerCase();
        if (fromName !== undefined && w.fromName) update.fromName = fromName?.trim() ?? "";
        if (replyTo !== undefined && w.replyTo) update.replyTo = replyTo ? replyTo.trim() : null
        return update;
    },
    afterCreate: async (_created, params) => {
        invalidateCompanyMailCache(params.company?._id);
    },
    afterUpdate: async (params) => {
        invalidateCompanyMailCache(params.company?._id);
    },
    afterDelete: async (params) => {
        invalidateCompanyMailCache(params.company?._id);
    },
});

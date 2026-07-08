import type {SmtpServer} from "armonia/src/modules/core/api/auxiliary/private/smtpServer/smtpServer.dto";
import type {ISmtpServer} from "@coreModule/database/schemas/smtpServer/smtpServer";
import {mapOwnershipToDTO, mapSoftDeleteToDTO} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

export function smtpServerToDTO(doc: ISmtpServer): SmtpServer {
    return {
        _id: doc._id.toString(),
        name: doc.name,
        sequence: doc.sequence,
        active: doc.active,
        host: doc.host,
        port: doc.port,
        encryption: doc.encryption,
        authType: doc.authType,
        username: doc.username || undefined,
        hasPassword: !!doc.passwordEncrypted,
        fromEmail: doc.fromEmail,
        fromName: doc.fromName?.trim() ? doc.fromName : undefined,
        replyTo: doc.replyTo?.trim() ? doc.replyTo : undefined,
        lastTestedAt: doc.lastTestedAt?.toISOString(),
        lastTestStatus: doc.lastTestStatus,
        lastTestMessage: doc.lastTestMessage?.trim() ? doc.lastTestMessage : undefined,
        ...mapSoftDeleteToDTO(doc),
        ...mapOwnershipToDTO(doc),
    };
}

export function smtpServersToDTO(docs: ISmtpServer[]): SmtpServer[] {
    return docs.map(smtpServerToDTO);
}

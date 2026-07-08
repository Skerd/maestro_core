import type {MessagingProvider} from "armonia/src/modules/core/api/auxiliary/private/messagingProvider/messagingProvider.dto";
import type {IMessagingProvider} from "@coreModule/database/schemas/messagingProvider/messagingProvider";
import {mapOwnershipToDTO, mapSoftDeleteToDTO} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

export function messagingProviderToDTO(doc: IMessagingProvider): MessagingProvider {
    return {
        _id:             doc._id.toString(),
        name:            doc.name,
        providerType:    doc.providerType,
        accountSid:      doc.accountSid,
        hasAuthToken:    !!doc.authTokenEncrypted,
        fromPhone:       doc.fromPhone?.trim() || undefined,
        fromWhatsapp:    doc.fromWhatsapp?.trim() || undefined,
        active:          doc.active,
        lastTestedAt:    doc.lastTestedAt?.toISOString(),
        lastTestStatus:  doc.lastTestStatus,
        lastTestMessage: doc.lastTestMessage?.trim() || undefined,
        ...mapSoftDeleteToDTO(doc),
        ...mapOwnershipToDTO(doc),
    };
}

export function messagingProvidersToDTO(docs: IMessagingProvider[]): MessagingProvider[] {
    return docs.map(messagingProviderToDTO);
}

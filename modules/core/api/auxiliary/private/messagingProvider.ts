import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import MessagingProvider from "@coreModule/database/schemas/messagingProvider/messagingProvider";
import {messagingProviderService} from "@coreModule/database/schemas/messagingProvider/messagingProvider.service";
import {messagingProvidersToDTO, messagingProviderToDTO} from "@coreModule/utilities/mappers/messagingProvider/messagingProviderMapper.dto";
import {messagingProvidersToSelect} from "@coreModule/utilities/mappers/messagingProvider/messagingProviderMapper.select";
import {createMessagingProviderFormSchema} from "armonia/src/modules/core/api/auxiliary/private/messagingProvider/createMessagingProvider.form.validator";
import {editMessagingProviderFormSchema} from "armonia/src/modules/core/api/auxiliary/private/messagingProvider/editMessagingProvider.form.validator";
import {encryptProviderToken} from "@coreModule/utilities/messaging/messagingDispatchService";
import {MessagingProviderActions} from "@coreModule/database/schemas/messagingProvider/messagingProvider.actions";

export const basePath = "/api/auxiliary/messagingProvider";

export const {router} = createCrudRouter({
    collectionName: "messagingproviders",
    model:          MessagingProvider,
    service:        messagingProviderService,
    createSchema:   createMessagingProviderFormSchema,
    editSchema:     editMessagingProviderFormSchema,
    toDTO:          messagingProviderToDTO,
    toDTOArray:     messagingProvidersToDTO,
    toSelect:       messagingProvidersToSelect,
    defaultSort:    {name: 1},
    entityName:     "MessagingProvider",
    actions:        MessagingProviderActions,
    buildCreateData: async ({name, providerType, accountSid, authToken, fromPhone, fromWhatsapp}: any) => ({
        name:              name.trim(),
        providerType,
        accountSid:        accountSid.trim(),
        authTokenEncrypted: authToken?.trim() ? encryptProviderToken(authToken.trim()) : undefined,
        fromPhone:         fromPhone?.trim() || undefined,
        fromWhatsapp:      fromWhatsapp?.trim() || undefined,
        active:            true,
    }),
    buildUpdateData: async ({name, providerType, accountSid, authToken, fromPhone, fromWhatsapp}: any, w: any) => {
        const update: Record<string, unknown> = {};
        if (name         !== undefined && w.name)         update.name         = name.trim();
        if (providerType !== undefined && w.providerType) update.providerType = providerType;
        if (accountSid   !== undefined && w.accountSid)   update.accountSid   = accountSid.trim();
        if (authToken?.trim() && w.accountSid)            update.authTokenEncrypted = encryptProviderToken(authToken.trim());
        if (fromPhone    !== undefined && w.fromPhone)    update.fromPhone    = fromPhone?.trim() || null;
        if (fromWhatsapp !== undefined && w.fromWhatsapp) update.fromWhatsapp = fromWhatsapp?.trim() || null;
        return update;
    },
});

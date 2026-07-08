import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import MessagingProvider, {IMessagingProvider} from "@coreModule/database/schemas/messagingProvider/messagingProvider";

export class MessagingProviderService extends BaseCrudService<IMessagingProvider, typeof MessagingProvider> {
    constructor() {
        super(MessagingProvider, "MessagingProvider");
    }
}

export const messagingProviderService = new MessagingProviderService();

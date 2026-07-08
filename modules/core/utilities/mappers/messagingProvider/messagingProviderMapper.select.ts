import type {IMessagingProvider} from "@coreModule/database/schemas/messagingProvider/messagingProvider";

export function messagingProvidersToSelect(docs: IMessagingProvider[]) {
    return docs.map((doc) => ({
        value: doc._id.toString(),
        label: doc.name,
    }));
}

import type {ApiSelectDatum} from "armonia/src/modules/core/types/shared.types";
import type {ICronJob} from "@coreModule/database/schemas/cronJob/cronJob";

export function cronJobsToSelect(docs: ICronJob[]): ApiSelectDatum[] {
    return docs.map(doc => ({
        value: doc._id.toString(),
        label: `${doc.name} (${doc.code})`,
    }));
}

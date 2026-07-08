import type {ApiSelectDatum} from "armonia/src/modules/core/types/shared.types";
import type {ISmtpServer} from "@coreModule/database/schemas/smtpServer/smtpServer";

export function smtpServersToSelect(docs: ISmtpServer[]): ApiSelectDatum[] {
    return docs.map((d) => ({
        value: d._id.toString(),
        label: `${d.name} (${d.host}:${d.port})`,
    }));
}

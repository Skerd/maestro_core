import SchemaGuard from "@coreModule/database/security/schemaGuard";
import Message from "@coreModule/database/schemas/message/message";
import type {SanitizedFields} from "armonia/src/modules/core/types";

/**
 * The populate for reading messages, plus the replied-to message's `status`. A reply quote shows that message's text
 * only while it is not deleted (`messageToDTO`), and no role reads `status` itself (server-owned), so without this the
 * quote's text was always empty.
 */
export function messagePopulate(readFields: SanitizedFields): ReturnType<typeof SchemaGuard.generatePopulate> {
    const populate = SchemaGuard.generatePopulate(readFields, Message.schema);
    const entries: {path?: string; select?: string}[] = Array.isArray(populate.populate)
        ? populate.populate
        : populate.populate ? [populate.populate] : [];
    for (const entry of entries) {
        if (entry.path === "replyTo" && entry.select && !/(^|\s)status(\s|$)/.test(entry.select)) entry.select += " status";
    }
    return populate;
}

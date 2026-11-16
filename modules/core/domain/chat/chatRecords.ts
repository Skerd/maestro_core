import {ObjectId} from "mongodb";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {MESSAGE_RECORDS_MAX, parseRecordRefs, recordRefKey, type MessageRecordRef} from "armonia/src/modules/core/helpers/chatTokens";
import type {ResolvedChatRecord} from "armonia/src/modules/core/api/user/private/chats/records/records.form.response.type";
import type {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {getRecordResource, selectRecords} from "@coreModule/utilities/endpoints/recordRegistry";

/**
 * Records shared in chat messages (D162). A message stores only `{collection, id}`; whoever reads it sees each record
 * through that record's own select, under their own permissions, so sharing never shows anyone more than they could
 * open themselves.
 */

/** Most ids one resource's select labels in one call (its form allows 200). */
const IDS_PER_SELECT = 200;

/** What `params`'s caller may see of each ref, in the order given. */
export async function resolveRecordRefs(params: AuthenticatedMWType, refs: MessageRecordRef[]): Promise<ResolvedChatRecord[]> {
    const byCollection = new Map<string, MessageRecordRef[]>();
    for (const ref of refs) {
        const list = byCollection.get(ref.collection.toLowerCase()) ?? [];
        list.push(ref);
        byCollection.set(ref.collection.toLowerCase(), list);
    }

    const resolved = new Map<string, ResolvedChatRecord>();
    for (const [collection, list] of byCollection) {
        const resource = getRecordResource(collection);
        for (let start = 0; start < list.length; start += IDS_PER_SELECT) {
            const chunk = list.slice(start, start + IDS_PER_SELECT);
            const ids = [...new Set(chunk.map((ref) => ref.id.toLowerCase()))];
            let result: Awaited<ReturnType<typeof selectRecords>> | {status: "failed"} = {status: "noAccess"};
            if (resource) {
                try {
                    result = await selectRecords(resource, params, {ids, page: 1, limit: ids.length});
                } catch (error) {
                    // One kind's broken select must not blank every other record on the screen: its records read as
                    // unavailable, and the failure is logged.
                    params.logger.err(`Resolving shared ${collection} records failed`, error);
                    result = {status: "failed"};
                }
            }
            const found = new Map<string, {label: string; photo?: string}>();
            if (result.status === "ok") {
                for (const datum of result.response.data) {
                    found.set(String(datum.value).toLowerCase(), {label: datum.label, ...(datum.photo ? {photo: datum.photo} : {})});
                }
            }
            for (const ref of chunk) {
                const id = ref.id.toLowerCase();
                const base = {collection: ref.collection, id};
                const hit = found.get(id);
                resolved.set(recordRefKey(ref), result.status === "noAccess"
                    ? {...base, status: "noAccess"}
                    : hit ? {...base, status: "ok", ...hit} : {...base, status: "unavailable"});
            }
        }
    }
    return refs.map((ref) => resolved.get(recordRefKey(ref))!);
}

/**
 * The records `text` shares, checked as its writer: at most {@link MESSAGE_RECORDS_MAX}, none in a public website chat,
 * and each one the writer can see. Refused otherwise; an empty list when the text shares none.
 */
export async function recordRefsToStore(
    params: AuthenticatedMWType,
    text: string,
    channel: {isPublicChat?: boolean},
): Promise<MessageRecordRef[]> {
    const refs = parseRecordRefs(text);
    if (refs.length === 0) return [];
    const {languageCode} = params;
    // A website visitor holds no permissions in the company: nothing they could open, so nothing to show them.
    if (channel.isPublicChat) throw apiValidationException("chat_records_not_allowed", "", null, languageCode);
    if (refs.length > MESSAGE_RECORDS_MAX) {
        throw apiValidationException("chat_records_too_many", "", null, languageCode, [String(MESSAGE_RECORDS_MAX)]);
    }
    const resolved = await resolveRecordRefs(params, refs);
    if (resolved.some((record) => record.status !== "ok")) {
        throw apiValidationException("chat_record_unavailable", "", null, languageCode);
    }
    // Stored under the collection's own name, whatever case the text used.
    return refs.map((ref) => ({collection: getRecordResource(ref.collection)!.collection, id: ref.id}));
}

/** The shape `Message.records` stores. */
export function storedRecordRefs(refs: MessageRecordRef[]): {kind: string; record: ObjectId}[] {
    return refs.map((ref) => ({kind: ref.collection, record: new ObjectId(ref.id)}));
}

/** `Message.records` read back as refs. */
export function refsOfStored(records: {kind: string; record: ObjectId}[] | undefined): MessageRecordRef[] {
    return (records ?? []).map((stored) => ({collection: stored.kind, id: stored.record.toString()}));
}

/** The refs among `refs` the caller can see, for content they did not write (a forwarded message's original). */
export async function visibleRecordRefs(params: AuthenticatedMWType, refs: MessageRecordRef[]): Promise<MessageRecordRef[]> {
    if (refs.length === 0) return [];
    const resolved = await resolveRecordRefs(params, refs);
    return refs
        .filter((_ref, index) => resolved[index].status === "ok")
        .map((ref) => ({collection: getRecordResource(ref.collection)!.collection, id: ref.id.toLowerCase()}));
}

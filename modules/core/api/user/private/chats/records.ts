import {Router} from "express";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {mapWithConcurrency} from "@coreModule/utilities/helpers/mapWithConcurrency";
import {
    callerMayRead,
    getRecordResource,
    mountedRecordResources,
    selectRecords,
} from "@coreModule/utilities/endpoints/recordRegistry";
import {resolveRecordRefs} from "@coreModule/domain/chat/chatRecords";
import {
    resolveChatRecordsFormSchema,
    searchChatRecordsFormSchema,
} from "armonia/src/modules/core/api/user/private/chats/records/records.form.validator";
import type {
    ResolveChatRecordsFormType,
    SearchChatRecordsFormType,
} from "armonia/src/modules/core/api/user/private/chats/records/records.form.type";
import type {
    ChatRecordGroup,
    ChatRecordTypesFormResponseType,
    ResolveChatRecordsFormResponseType,
    SearchChatRecordsFormResponseType,
} from "armonia/src/modules/core/api/user/private/chats/records/records.form.response.type";
import type {SelectResponse} from "armonia/src/modules/core/types/shared.types";

/**
 * Records in chat (D162): find any record to share, and see what you may of the records a message shares. Every kind of
 * record is covered by the record registry (`recordRegistry.ts`), and each read goes through that record's own select,
 * under the caller's permissions.
 *
 * **Routes:**
 * - `POST /search` – records whose label matches `q`: the first few of every kind the caller may read, or one kind paged.
 * - `POST /resolve` – for each `{collection, id}`, its label and photo, or `noAccess` / `unavailable`.
 * - `POST /types` – the kinds of record the caller may share.
 */

const router = Router();

/** Kinds searched at once; the rest wait. */
const SEARCH_CONCURRENCY = 8;
/** A search across every kind needs this many characters. */
const SEARCH_MIN_CHARS = 2;
/** Results per kind when searching every kind. */
const SEARCH_PER_KIND = 3;
/** Results per page when paging one kind. */
const PAGE_SIZE = 20;

function groupOf(collection: string, response: SelectResponse): ChatRecordGroup {
    return {
        collection,
        total: response.total,
        items: response.data.map((datum) => ({
            id: String(datum.value),
            label: datum.label,
            ...(datum.photo ? {photo: datum.photo} : {}),
        })),
    };
}

router.post(
    "/search",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 120}),
    validateFormZod(searchChatRecordsFormSchema),
    asyncHandler(searchRecords),
);
async function searchRecords(params: AuthenticatedMWType & SearchChatRecordsFormType): Promise<SearchChatRecordsFormResponseType> {
    const {logger} = params;
    const q = params.q?.trim() ?? "";

    if (params.collection) {
        const resource = getRecordResource(params.collection);
        if (!resource) return {groups: []};
        const limit = params.limit ?? PAGE_SIZE;
        const result = await selectRecords(resource, params, {...(q ? {name: q} : {}), page: params.page ?? 1, limit});
        return {groups: result.status === "ok" ? [groupOf(resource.collection, result.response)] : []};
    }

    if (q.length < SEARCH_MIN_CHARS) return {groups: []};
    logger.start(`Searching shareable records for "${q}"...`);
    const limit = params.limit ?? SEARCH_PER_KIND;
    const groups = await mapWithConcurrency(mountedRecordResources(), SEARCH_CONCURRENCY, async (resource) => {
        try {
            const result = await selectRecords(resource, params, {name: q, page: 1, limit});
            return result.status === "ok" ? groupOf(resource.collection, result.response) : null;
        } catch (error) {
            // One kind failing must not hide the others.
            logger.err(`Record search failed for ${resource.collection}`, error);
            return null;
        }
    });
    const found = groups.filter((group): group is ChatRecordGroup => !!group && group.items.length > 0);
    logger.finish(`Found records in ${found.length} kind(s)`);
    return {groups: found};
}

router.post(
    "/resolve",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 240}),
    validateFormZod(resolveChatRecordsFormSchema),
    asyncHandler(resolveRecords),
);
async function resolveRecords(params: AuthenticatedMWType & ResolveChatRecordsFormType): Promise<ResolveChatRecordsFormResponseType> {
    return {records: await resolveRecordRefs(params, params.refs)};
}

router.post(
    "/types",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(recordTypes),
);
async function recordTypes(params: AuthenticatedMWType): Promise<ChatRecordTypesFormResponseType> {
    return {
        collections: mountedRecordResources()
            .filter((resource) => callerMayRead(resource, params))
            .map((resource) => resource.collection)
            .sort(),
    };
}

export const basePath = "/api/user/chats/records";
export {router};

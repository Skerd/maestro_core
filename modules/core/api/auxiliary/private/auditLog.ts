import {Request, Router} from "express";
import {ObjectId} from "mongodb";
import AuditLog, {AuditDiffEntry} from "@coreModule/database/schemas/auditLog/auditLog";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {COLLECTED_DATA} from "@coreModule/database/collections";
import {SanitizedFields} from "armonia/src/modules/core/types";
import {
    DocumentAuditActorDto,
    DocumentAuditChangeDto,
    DocumentAuditEntryDto,
    DocumentAuditLogResponseDto,
} from "armonia/src/modules/core/api/auxiliary/private/auditLog/documentAuditLog.dto";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {ValidationError} from "armonia/src/modules/core/types";

export const basePath = "/api/auxiliary/auditLog";

const router = Router();

router.get(
    "/document",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(getDocumentAuditLogs),
);

type DocAuditParams = AuthenticatedMWType;

type AuditCursor = {createdAt: string; id: string};

const OBJECT_ID_HEX = /^[a-f0-9]{24}$/i;

function normalizeQuery(value: unknown): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (Array.isArray(value)) {
        const first = value[0];
        return first === undefined || first === null ? undefined : String(first).trim();
    }
    return String(value).trim();
}

function parseDocumentAuditQuery(
    query: Request["query"],
    languageCode: string,
): {documentId: string; collectionName: string; limit: number; cursorRaw: string | undefined} {
    const documentId = normalizeQuery(query.documentId) ?? "";
    const collectionName = (normalizeQuery(query.collectionName) ?? "").toLowerCase();
    const limitRaw = normalizeQuery(query.limit);
    let limit = Number.parseInt(limitRaw ?? "25", 10);
    if (!Number.isFinite(limit)) {
        limit = 25;
    }
    limit = Math.min(50, Math.max(1, limit));

    const errors: ValidationError[] = [];
    if (!OBJECT_ID_HEX.test(documentId)) {
        errors.push({
            message: "invalid_document_id",
            error_code: "custom",
            extra_message: undefined,
            content: undefined,
            path: "documentId",
        });
    }
    if (!collectionName || !/^[a-z0-9_-]+$/i.test(collectionName) || collectionName.length > 128) {
        errors.push({
            message: "invalid_collection_name",
            error_code: "custom",
            extra_message: undefined,
            content: undefined,
            path: "collectionName",
        });
    }
    if (errors.length > 0) {
        throw apiValidationException("form_not_correct", "", errors, languageCode);
    }

    const cursorRawNorm = normalizeQuery(query.cursor);
    return {documentId, collectionName, limit, cursorRaw: cursorRawNorm || undefined};
}

function parseAuditCursor(raw: string | undefined): AuditCursor | null {
    if (!raw) {
        return null;
    }
    try {
        const json = Buffer.from(raw, "base64url").toString("utf8");
        const parsed = JSON.parse(json) as unknown;
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            "createdAt" in parsed &&
            "id" in parsed &&
            typeof (parsed as {createdAt: unknown}).createdAt === "string" &&
            typeof (parsed as {id: unknown}).id === "string"
        ) {
            return {createdAt: (parsed as {createdAt: string}).createdAt, id: (parsed as {id: string}).id};
        }
    } catch {
        /* ignore */
    }
    return null;
}

function encodeAuditCursor(c: AuditCursor): string {
    return Buffer.from(JSON.stringify({createdAt: c.createdAt, id: c.id}), "utf8").toString("base64url");
}

function isTopLevelFieldReadable(field: string, sanitized: SanitizedFields): boolean {
    return Object.prototype.hasOwnProperty.call(sanitized, field);
}

function filterAuditDiff(
    diff: Record<string, AuditDiffEntry> | null | undefined,
    sanitized: SanitizedFields,
): Record<string, AuditDiffEntry> {
    if (!diff) {
        return {};
    }
    const out: Record<string, AuditDiffEntry> = {};
    for (const [key, entry] of Object.entries(diff)) {
        if (key === "__v") {
            continue;
        }
        if (!isTopLevelFieldReadable(key, sanitized)) {
            continue;
        }
        out[key] = entry;
    }
    return out;
}

function actorDto(populated: unknown): DocumentAuditActorDto | null {
    if (!populated || typeof populated !== "object" || Array.isArray(populated)) {
        return null;
    }
    const p = populated as {_id?: ObjectId; name?: string; surname?: string; email?: string};
    const id = p._id;
    if (!id) {
        return null;
    }
    const parts = [p.name, p.surname].filter((x) => !!x && String(x).trim().length > 0) as string[];
    const displayName = parts.join(" ").trim() || p.email || String(id);
    return {
        id: String(id),
        displayName,
    };
}

function serializeRawValue(v: unknown): unknown {
    if (v === null || v === undefined) {
        return v;
    }
    if (typeof v === "object" && v !== null) {
        if (Array.isArray(v)) {
            return v.map((item) => serializeRawValue(item));
        }
        if (v instanceof Date) {
            return v.toISOString();
        }
        if (typeof (v as {_bsontype?: string})._bsontype === "string" && (v as {_bsontype?: string})._bsontype === "ObjectId") {
            return String(v);
        }
        if ("toHexString" in v && typeof (v as {toHexString: () => string}).toHexString === "function") {
            try {
                return String((v as {toHexString: () => string}).toHexString());
            } catch {
                /* fall through */
            }
        }
        const plain: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            plain[k] = serializeRawValue(val);
        }
        return plain;
    }
    return v;
}

function toChanges(filtered: Record<string, AuditDiffEntry>): DocumentAuditChangeDto[] {
    return Object.entries(filtered).map(([field, entry]) => ({
        field,
        from: serializeRawValue(entry.from),
        to: serializeRawValue(entry.to),
    }));
}

async function getDocumentAuditLogs(reqBody: DocAuditParams, _routeParams: unknown, req: Request): Promise<DocumentAuditLogResponseDto> {
    const {logger, languageCode, company, actionUserCtx} = reqBody;

    const parsed = parseDocumentAuditQuery(req.query, languageCode);
    const {documentId, collectionName, limit, cursorRaw} = parsed;

    const collected = COLLECTED_DATA[collectionName];
    if (!collected?.model || !collected.readFields) {
        throw apiValidationException("not_found", "", null, languageCode);
    }

    const sanitizedRead = SchemaGuard.sanitizeFields(collected.model, collected.readFields, "read", actionUserCtx, languageCode);

    let entityQ = collected.model.findOne({_id: new ObjectId(documentId), company: company._id}).select("_id");
    const qAny = entityQ as {withDeleted?: () => typeof entityQ};
    if (typeof qAny.withDeleted === "function") {
        entityQ = qAny.withDeleted();
    }
    const entityRow = await entityQ.lean();
    if (!entityRow) {
        throw apiValidationException("not_found", "", null, languageCode);
    }

    const cursor = parseAuditCursor(cursorRaw);
    const oid = new ObjectId(documentId);

    const filter: Record<string, unknown> = {
        collectionName,
        documentId: oid,
    };

    if (cursor) {
        const cAt = new Date(cursor.createdAt);
        const cId = new ObjectId(cursor.id);
        filter.$or = [{createdAt: {$lt: cAt}}, {$and: [{createdAt: cAt}, {_id: {$lt: cId}}]}];
    }

    logger.start(`Fetching audit logs for ${collectionName}/${documentId}...`);

    const rawEntries = await AuditLog.find(filter)
        .sort({createdAt: -1, _id: -1})
        .limit(limit + 1)
        .populate({
            path: "actorId",
            select: "name surname email",
        })
        .lean();

    const hasMore = rawEntries.length > limit;
    const slice = hasMore ? rawEntries.slice(0, limit) : rawEntries;

    const entries: DocumentAuditEntryDto[] = slice.map((doc) => {
        const diffFiltered = filterAuditDiff(doc.diff as Record<string, AuditDiffEntry>, sanitizedRead);
        const actor = actorDto(doc.actorId);
        return {
            id: String(doc._id),
            createdAt:
                doc.createdAt instanceof Date ? doc.createdAt.toISOString() : new Date(doc.createdAt as string).toISOString(),
            action: doc.action,
            actor,
            changes: toChanges(diffFiltered),
        };
    });

    let nextCursorOut: string | null = null;
    if (hasMore && slice.length > 0) {
        const last = slice[slice.length - 1]!;
        const lastAt = last.createdAt instanceof Date ? last.createdAt : new Date(last.createdAt as string);
        nextCursorOut = encodeAuditCursor({createdAt: lastAt.toISOString(), id: String(last._id)});
    }

    logger.finish(`Fetched ${entries.length} audit log row(s).`);

    return {
        entries,
        nextCursor: nextCursorOut,
    };
}

export {router};

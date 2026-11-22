/**
 * The platform's upload review (D177): an upload the content check refuses is logged, a file it flags is announced to
 * the platform's reviewers, and the reviewers approve or remove each flagged file, telling whoever uploaded it.
 * Health files (D102) are never part of it: only their own company may open them, so they stay flagged there.
 *
 * @module domain/uploadReview/uploadReview
 */

import {createHash} from "crypto";
import {ObjectId} from "mongodb";
import type {ClientSession} from "mongoose";
import {mediaService, type ReviewableMedia} from "@coreModule/database/schemas/media/media.service";
import UploadRefusal, {UPLOAD_REFUSAL_CODES, type IUploadRefusal} from "@coreModule/database/schemas/uploadRefusal/uploadRefusal";
import {uploadRefusalService} from "@coreModule/database/schemas/uploadRefusal/uploadRefusal.service";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {findPlatformCompanyId} from "@coreModule/utilities/security/platformAccess";
import {companyMemberIdsWithPermission} from "@coreModule/domain/roles/companyPermissionHolders";
import {actionPermissionTag} from "@coreModule/utilities/security/actionPermissions";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
import {pushWebsocketMessage} from "@coreModule/connections/connectToWebSocketServer";
import {runAfterCommit} from "@coreModule/utilities/middlewares/transactionUtils";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {getLogger, type serverLogger} from "@coreModule/loggers/serverLog";
import type {ModerationScores} from "@coreModule/utilities/security/contentModerator";
import {
    UPLOAD_REVIEW_COUNTS_CODE,
    type UploadReviewCounts,
    type UploadReviewItem,
    type UploadReviewListResponse,
    type UploadReviewView,
} from "armonia/src/modules/core/api/auxiliary/private/uploadReview/uploadReview.dto";

/**
 * The permission of the platform's reviewers: the `reviewUploads` action of the platform-only `UploadRefusal` model,
 * which the panel's access map lists (Media is not in it).
 */
export const REVIEW_UPLOADS_PERMISSION = "reviewUploads";

/** Who sent an upload, and where. */
export type UploaderContext = {companyId?: unknown; userId?: unknown; route: string};

/** The decisions of the review and the statuses each one may follow. */
const DECISION_FROM: Record<"approved" | "rejected", readonly string[]> = {
    approved: ["flagged", "rejected"],
    rejected: ["flagged", "approved"],
};

/** Whether a file with this status may get this decision (approving a removed file, or removing an approved one, undoes it). */
export function mayDecide(status: string | undefined, decision: "approved" | "rejected"): boolean {
    return status !== undefined && DECISION_FROM[decision].includes(status);
}

const idOf = (value: unknown): ObjectId | undefined => {
    const raw = (value as {_id?: unknown} | null | undefined)?._id ?? value;
    return raw && ObjectId.isValid(String(raw)) ? new ObjectId(String(raw)) : undefined;
};

/**
 * Logs an upload the content check refused, for the platform's review: never the file, only its SHA-256. Written
 * without the request's transaction, which the refusal rolls back. Best effort: a failure is logged and never changes
 * the refusal.
 */
export async function recordUploadRefusal(args: {
    bytes: Buffer;
    fileName: string;
    mimeType: string;
    errorCode: (typeof UPLOAD_REFUSAL_CODES)[number];
    scores: ModerationScores;
    uploader: UploaderContext;
    logger: serverLogger;
}): Promise<void> {
    const {bytes, fileName, mimeType, errorCode, scores, uploader, logger} = args;
    const company = idOf(uploader.companyId);
    if (!company) {
        logger.warn(`Refused upload ${fileName} not logged for review: the request has no company`);
        return;
    }
    try {
        await uploadRefusalService.create({
            fileName,
            mimeType,
            fileSize: bytes.length,
            fileHash: createHash("sha256").update(bytes).digest("hex"),
            route: uploader.route,
            errorCode,
            scores,
            company,
            createdBy: idOf(uploader.userId),
        }, {logger});
    } catch (error) {
        logger.warn(`Refused upload ${fileName} not logged for review: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** The platform company and the users there who review uploads; none while there is no platform company. */
async function platformReviewers(): Promise<{platformId: ObjectId; reviewerIds: string[]} | null> {
    const platformId = await findPlatformCompanyId();
    if (!platformId) return null;
    // The platform's roles are read in its own tenant.
    const reviewerIds = await withTenant(platformId, () =>
        companyMemberIdsWithPermission(platformId, actionPermissionTag(UploadRefusal, REVIEW_UPLOADS_PERMISSION, "self")));
    return {platformId, reviewerIds};
}

/** How many files each of the review's lists holds, every company's. */
export function uploadReviewCounts(): Promise<UploadReviewCounts> {
    return asCrossTenant("the platform reviews every company's flagged uploads (D177)", async () => {
        const [flagged, rejected, approved, refused] = await Promise.all([
            mediaService.countForReview("flagged"),
            mediaService.countForReview("rejected"),
            mediaService.countForReview("approved"),
            uploadRefusalService.countAll(),
        ]);
        return {flagged, rejected, approved, refused};
    });
}

/**
 * Brings the platform's reviewers the new counts (`UPLOAD_REVIEW_COUNTS_CODE`), for the menu's badge and an open
 * review page. Best effort: a failure is only logged.
 */
export async function publishUploadReviewCounts(logger: serverLogger = getLogger("upload_review")): Promise<void> {
    try {
        const reviewers = await platformReviewers();
        if (!reviewers?.reviewerIds.length) return;
        pushWebsocketMessage({code: UPLOAD_REVIEW_COUNTS_CODE, payload: {counts: await uploadReviewCounts()}, userIds: reviewers.reviewerIds});
    } catch (error) {
        logger.warn(`Upload review counts not sent: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Tells the platform's reviewers that one upload stored files the content check flagged, the uploader too when they
 * review: one notice per upload and the new counts, after the request's transaction commits. Health files are left
 * out by the caller.
 */
export async function notifyUploadsFlagged(
    files: {mediaId: string; fileName: string}[],
    args: {companyName: string; languageCode: string; session?: ClientSession},
): Promise<void> {
    if (files.length === 0) return;
    const reviewers = await platformReviewers();
    if (!reviewers?.reviewerIds.length) return;
    const {platformId, reviewerIds: receiverIds} = reviewers;
    await runAfterCommit(args.session, () => publishUploadReviewCounts());
    emitNotificationEvent(NotificationEventCodes.UPLOAD_FLAGGED, {
        receiverIds,
        payload: {
            companyId: platformId.toString(),
            name: files[0].fileName,
            count: files.length,
            ...(files.length > 1 ? {variant: "several"} : {}),
            uploaderCompanyName: args.companyName,
            mediaId: files[0].mediaId,
            languageCode: args.languageCode,
        },
        session: args.session,
    });
}

/** Tells whoever uploaded a flagged file what the platform decided; after the decision commits. */
function notifyUploader(media: ReviewableMedia, decision: "approved" | "rejected", languageCode: string, session?: ClientSession): void {
    const receiver = idOf(media.createdBy);
    const company = idOf(media.company);
    if (!receiver || !company) return;
    emitNotificationEvent(decision === "approved" ? NotificationEventCodes.UPLOAD_REVIEW_APPROVED : NotificationEventCodes.UPLOAD_REVIEW_REMOVED, {
        receiverIds: [receiver.toString()],
        payload: {companyId: company.toString(), name: media.originalName, mediaId: media._id.toString(), languageCode},
        session,
    });
}

/** Names of companies and users by id, for one page of the review. */
async function namesOf(companyIds: ObjectId[], userIds: ObjectId[]): Promise<{companies: Map<string, string>; users: Map<string, string>}> {
    const [companies, users] = await Promise.all([
        companyIds.length ? companyService.find({_id: {$in: companyIds}}, {}, undefined, "_id name") : [],
        userIds.length ? userService.find({_id: {$in: userIds}}, {}, undefined, "_id fullName") : [],
    ]);
    return {
        companies: new Map(companies.map((company): [string, string] => [company._id.toString(), company.name ?? ""])),
        users: new Map(users.map((user): [string, string] => [user._id.toString(), user.fullName ?? ""])),
    };
}

const named = (id: ObjectId | undefined, names: Map<string, string>) =>
    id ? {_id: id.toString(), name: names.get(id.toString()) ?? ""} : undefined;

async function mediaItems(docs: ReviewableMedia[]): Promise<UploadReviewItem[]> {
    const companyIds = docs.flatMap((doc) => idOf(doc.company) ?? []);
    const userIds = docs.flatMap((doc) => [idOf(doc.createdBy), idOf(doc.metadata?.moderation?.reviewedBy)].flatMap((id) => id ?? []));
    const {companies, users} = await namesOf(companyIds, userIds);
    return docs.map((doc) => {
        const moderation = doc.metadata?.moderation;
        return {
            _id: doc._id.toString(),
            kind: "media",
            fileName: doc.originalName,
            mimeType: doc.mimeType,
            fileSize: doc.fileSize,
            fileType: doc.type,
            isPublic: doc.isPublic === true,
            inUse: doc.pendingReference !== true,
            checkedAt: moderation?.checkedAt?.toISOString(),
            company: named(idOf(doc.company), companies) ?? {_id: "", name: ""},
            uploadedBy: named(idOf(doc.createdBy), users),
            uploadedAt: (doc.createdAt ?? doc._id.getTimestamp()).toISOString(),
            status: moderation?.status ?? "flagged",
            scores: moderation?.scores,
            reviewedAt: moderation?.reviewedAt?.toISOString(),
            reviewedBy: named(idOf(moderation?.reviewedBy), users),
        };
    });
}

async function refusalItems(docs: IUploadRefusal[]): Promise<UploadReviewItem[]> {
    const {companies, users} = await namesOf(
        docs.flatMap((doc) => idOf(doc.company) ?? []),
        docs.flatMap((doc) => idOf(doc.createdBy) ?? []),
    );
    return docs.map((doc) => ({
        _id: doc._id.toString(),
        kind: "refusal",
        fileName: doc.fileName,
        mimeType: doc.mimeType,
        fileSize: doc.fileSize,
        company: named(idOf(doc.company), companies) ?? {_id: "", name: ""},
        uploadedBy: named(idOf(doc.createdBy), users),
        uploadedAt: (doc.createdAt ?? doc._id.getTimestamp()).toISOString(),
        status: "refused",
        scores: doc.scores,
        fileHash: doc.fileHash,
        route: doc.route,
        refusalCode: doc.errorCode,
    }));
}

/** One page of one of the review's lists, newest first, with how many each list holds. Every company's: run cross-tenant. */
export async function listUploadReview(view: UploadReviewView, page: number, limit: number): Promise<UploadReviewListResponse> {
    const skip = (page - 1) * limit;
    const counts = await uploadReviewCounts();
    const items = view === "refused"
        ? await refusalItems(await uploadRefusalService.findPage(skip, limit))
        : await mediaItems(await mediaService.findForReviewPage(view, skip, limit));
    return {items, total: counts[view], page, limit, counts};
}

/** One stored file under review, as its list shows it, or null (not under review, deleted, or a health file). */
export async function uploadReviewItem(mediaId: ObjectId): Promise<UploadReviewItem | null> {
    const media = await mediaService.findOneForReview(mediaId);
    if (!media || !["flagged", "rejected", "approved"].includes(media.metadata?.moderation?.status ?? "")) return null;
    const [item] = await mediaItems([media]);
    return item;
}

/**
 * Approves (`approved`: shown as any file) or removes (`rejected`: kept, blurred for staff, never sent to visitors) a
 * flagged file, and tells whoever uploaded it. Every company's: run cross-tenant.
 */
export async function decideUploadReview(args: {
    mediaId: ObjectId;
    decision: "approved" | "rejected";
    reviewerId: unknown;
    languageCode: string;
    session?: ClientSession;
    logger?: serverLogger;
    notOpen: () => Error;
    notFound: () => Error;
}): Promise<UploadReviewItem> {
    const {mediaId, decision, reviewerId, languageCode, session, logger} = args;
    const media = await mediaService.findOneForReview(mediaId, session);
    if (!media) throw args.notFound();
    if (!mayDecide(media.metadata?.moderation?.status, decision)) throw args.notOpen();
    const reviewer = idOf(reviewerId);
    await mediaService.updateByIdOrThrow(media._id, {
        $set: {
            "metadata.moderation.status": decision,
            "metadata.moderation.reviewedAt": new Date(),
            ...(reviewer && {"metadata.moderation.reviewedBy": reviewer}),
        },
    }, {session, logger, languageCode, auditUserId: reviewer?.toString()});
    notifyUploader(media, decision, languageCode, session);
    await runAfterCommit(session, () => publishUploadReviewCounts(logger));
    const decided = await mediaService.findOneForReview(mediaId, session);
    if (!decided) throw args.notFound();
    const [item] = await mediaItems([decided]);
    return item;
}


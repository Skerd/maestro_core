/**
 * Media Service
 *
 * CRUD service for Media model.
 */

import {Types, type ClientSession} from 'mongoose';
import {BaseCrudService} from '@coreModule/database/services/baseCrudService';
import Media, {IMedia} from '@coreModule/database/schemas/media/media';

/** What the upload review reads of a file (D177). */
export type ReviewableMedia = Pick<IMedia, '_id' | 'type' | 'originalName' | 'mimeType' | 'fileSize' | 'metadata' | 'createdAt' | 'isPublic' | 'pendingReference'> & {
    company?: Types.ObjectId;
    createdBy?: Types.ObjectId;
};

const REVIEWABLE_PROJECTION = {
    type: 1, originalName: 1, mimeType: 1, fileSize: 1, isPublic: 1, pendingReference: 1, company: 1, createdBy: 1, createdAt: 1, "metadata.moderation": 1,
};

export class MediaService extends BaseCrudService<IMedia, typeof Media> {
    constructor() {
        super(Media, 'Media');
    }

    /**
     * Hands uploads to `core.orphanUploadCleanup`, which after its grace period deletes the ones no record references
     * and keeps the rest. For the files of a request that failed without a transaction: a record saved before the
     * failure may already point at them, so they are not deleted outright (TD-B249).
     */
    async markPendingReference(mediaIds: string[]): Promise<void> {
        if (mediaIds.length === 0) return;
        // The raw collection, as the cleanup job uses it: a housekeeping flag, not a change a person made.
        await this.model.collection.updateMany(
            {_id: {$in: mediaIds.map(id => new Types.ObjectId(id))}},
            {$set: {pendingReference: true}},
        );
    }

    /**
     * Stored files of these types the content check has not judged (D177): uploaded before it, or recorded
     * `not_checked` because it could not run. Every company's, in `_id` order after `afterId`. Raw: a platform-wide
     * maintenance read.
     */
    async findNotModerated(types: string[], afterId: Types.ObjectId | null, limit: number) {
        return this.model.collection.find<Pick<IMedia, '_id' | 'type' | 'originalName' | 'fileId' | 'encrypted' | 'company'>>({
            type: {$in: types},
            fileId: {$exists: true},
            $or: [{"metadata.moderation": {$exists: false}}, {"metadata.moderation.status": "not_checked"}],
            deletedAt: null,
            ...(afterId && {_id: {$gt: afterId}}),
        }).sort({_id: 1}).limit(limit).toArray();
    }

    /** The upload review's files with this status (D177): every company's, health files left out (only their company opens them). */
    private reviewFilter(status: string): Record<string, unknown> {
        return {"metadata.moderation.status": status, fileId: {$exists: true}, encrypted: {$ne: true}, deletedAt: null};
    }

    /** One page of the upload review's files with this status, newest decision or upload first. Raw: the platform reads across companies. */
    async findForReviewPage(status: string, skip: number, limit: number): Promise<ReviewableMedia[]> {
        return this.model.collection.find<ReviewableMedia>(this.reviewFilter(status), {projection: REVIEWABLE_PROJECTION})
            .sort({"metadata.moderation.reviewedAt": -1, _id: -1}).skip(skip).limit(limit).toArray();
    }

    async countForReview(status: string): Promise<number> {
        return this.model.collection.countDocuments(this.reviewFilter(status));
    }

    /** A file the upload review may decide: stored, not deleted, not a health file. Raw: the platform reads across companies. */
    async findOneForReview(mediaId: Types.ObjectId, session?: ClientSession): Promise<ReviewableMedia | null> {
        return this.model.collection.findOne<ReviewableMedia>(
            {_id: mediaId, fileId: {$exists: true}, encrypted: {$ne: true}, deletedAt: null},
            {projection: REVIEWABLE_PROJECTION, session},
        );
    }

    /** Records the content check's verdict on a stored file (D177). Raw, like the check that sets it on upload. */
    async setModeration(mediaId: Types.ObjectId, moderation: NonNullable<IMedia['metadata']['moderation']>): Promise<void> {
        await this.model.collection.updateOne({_id: mediaId}, {$set: {"metadata.moderation": moderation}});
    }
}

export const mediaService = new MediaService();

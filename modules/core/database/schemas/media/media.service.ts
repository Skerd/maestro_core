/**
 * Media Service
 *
 * CRUD service for Media model.
 */

import {Types} from 'mongoose';
import {BaseCrudService} from '@coreModule/database/services/baseCrudService';
import Media, {IMedia} from '@coreModule/database/schemas/media/media';

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
}

export const mediaService = new MediaService();

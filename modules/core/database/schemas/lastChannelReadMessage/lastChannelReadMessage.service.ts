/**
 * LastChannelReadMessage Service
 * 
 * CRUD service for LastChannelReadMessage model.
 */

import type {ObjectId} from 'mongodb';
import {BaseCrudService} from '@coreModule/database/services/baseCrudService';
import LastChannelReadMessage, {
    ILastChannelReadMessage
} from '@coreModule/database/schemas/lastChannelReadMessage/lastChannelReadMessage';

export class LastChannelReadMessageService extends BaseCrudService<ILastChannelReadMessage, typeof LastChannelReadMessage> {
    constructor() {
        super(LastChannelReadMessage, 'LastChannelReadMessage');
    }

    /** Moves the user's read marker in the channel to `time`, creating the marker when missing. */
    async markReadUntil(userId: ObjectId, channelId: ObjectId, time: Date): Promise<void> {
        await this.model.findOneAndUpdate({user: userId, channel: channelId}, {$set: {time}}, {upsert: true});
    }

    /** The user's read markers in these channels (channel and time only). */
    async findReadTimes(userId: ObjectId, channelIds: ObjectId[]) {
        return this.model.find({user: userId, channel: {$in: channelIds}}).select("channel time").lean();
    }
}

export const lastChannelReadMessageService = new LastChannelReadMessageService();


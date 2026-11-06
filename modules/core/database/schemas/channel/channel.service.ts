/**
 * Channel Service
 * 
 * CRUD service for Channel model.
 */

import type {FilterQuery} from 'mongoose';
import {BaseCrudService} from '@coreModule/database/services/baseCrudService';
import Channel, {IChannel} from '@coreModule/database/schemas/channel/channel';

export class ChannelService extends BaseCrudService<IChannel, typeof Channel> {
    constructor() {
        super(Channel, 'Channel');
    }

    /** Plain rows of the channels matching `filter`, with only the `select`ed fields (badges, sweeps). */
    async findRows<R>(filter: FilterQuery<IChannel>, select: string): Promise<R[]> {
        return this.model.find(filter).select(select).lean<R[]>();
    }
}

export const channelService = new ChannelService();


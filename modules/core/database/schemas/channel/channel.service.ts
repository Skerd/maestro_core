/**
 * Channel Service
 * 
 * CRUD service for Channel model.
 */

import {BaseCrudService} from '@coreModule/database/services/baseCrudService';
import Channel, {IChannel} from '@coreModule/database/schemas/channel/channel';

export class ChannelService extends BaseCrudService<IChannel, typeof Channel> {
    constructor() {
        super(Channel, 'Channel');
    }
}

export const channelService = new ChannelService();


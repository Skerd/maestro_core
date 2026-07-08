/**
 * LastChannelReadMessage Service
 * 
 * CRUD service for LastChannelReadMessage model.
 */

import {BaseCrudService} from '@coreModule/database/services/baseCrudService';
import LastChannelReadMessage, {
    ILastChannelReadMessage
} from '@coreModule/database/schemas/lastChannelReadMessage/lastChannelReadMessage';

export class LastChannelReadMessageService extends BaseCrudService<ILastChannelReadMessage, typeof LastChannelReadMessage> {
    constructor() {
        super(LastChannelReadMessage, 'LastChannelReadMessage');
    }
}

export const lastChannelReadMessageService = new LastChannelReadMessageService();


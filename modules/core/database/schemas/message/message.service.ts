/**
 * Message Service
 * 
 * CRUD service for Message model.
 */

import {BaseCrudService} from '@coreModule/database/services/baseCrudService';
import Message, {IMessage} from '@coreModule/database/schemas/message/message';

export class MessageService extends BaseCrudService<IMessage, typeof Message> {
    constructor() {
        super(Message, 'Message');
    }
}

export const messageService = new MessageService();


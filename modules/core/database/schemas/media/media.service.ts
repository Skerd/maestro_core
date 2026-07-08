/**
 * Media Service
 * 
 * CRUD service for Media model.
 */

import {BaseCrudService} from '@coreModule/database/services/baseCrudService';
import Media, {IMedia} from '@coreModule/database/schemas/media/media';

export class MediaService extends BaseCrudService<IMedia, typeof Media> {
    constructor() {
        super(Media, 'Media');
    }
}

export const mediaService = new MediaService();


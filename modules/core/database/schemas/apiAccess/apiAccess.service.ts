/**
 * ApiAccess Service
 *
 * CRUD service for ApiAccess model.
 */

import {BaseCrudService} from '@coreModule/database/services/baseCrudService';
import ApiAccess, {IApiAccess} from '@coreModule/database/schemas/apiAccess/apiAccess';

export class ApiAccessService extends BaseCrudService<IApiAccess, typeof ApiAccess> {
    constructor() {
        super(ApiAccess, 'ApiAccess');
    }
}

export const apiAccessService = new ApiAccessService();

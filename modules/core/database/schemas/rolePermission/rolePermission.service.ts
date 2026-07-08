/**
 * RolePermission Service
 * 
 * CRUD service for RolePermission model.
 */

import {BaseCrudService} from '@coreModule/database/services/baseCrudService';
import RolePermission, {IRolePermission} from '@coreModule/database/schemas/rolePermission/rolePermission';

export class RolePermissionService extends BaseCrudService<IRolePermission, typeof RolePermission> {
    constructor() {
        super(RolePermission, 'RolePermission');
    }
}

export const rolePermissionService = new RolePermissionService();


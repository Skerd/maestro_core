/**
 * AuditLog Service
 * 
 * CRUD service for AuditLog model.
 */

import {BaseCrudService} from '@coreModule/database/services/baseCrudService';
import AuditLog, {IAuditLog} from '@coreModule/database/schemas/auditLog/auditLog';

export class AuditLogService extends BaseCrudService<IAuditLog, typeof AuditLog> {
    constructor() {
        super(AuditLog, 'AuditLog');
    }
}

export const auditLogService = new AuditLogService();

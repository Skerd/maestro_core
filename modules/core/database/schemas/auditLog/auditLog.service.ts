/**
 * AuditLog Service
 * 
 * CRUD service for AuditLog model.
 */

import {ClientSession, Types} from 'mongoose';
import {BaseCrudService} from '@coreModule/database/services/baseCrudService';
import AuditLog, {IAuditLog} from '@coreModule/database/schemas/auditLog/auditLog';

export class AuditLogService extends BaseCrudService<IAuditLog, typeof AuditLog> {
    constructor() {
        super(AuditLog, 'AuditLog');
    }

    /** Person erasure (D57): one ERASE entry per erased record (who and when), written in the erasure's transaction. */
    async recordErasures(entries: Record<string, unknown>[], session?: ClientSession): Promise<void> {
        await this.model.collection.insertMany(entries, {session});
    }

    /**
     * Person erasure (D57): blanks every recorded value in these documents' change history, keeping which fields
     * changed and when. For records an erasure deleted, whose whole history was about the person.
     */
    async blankAllDiffValues(companyId: Types.ObjectId, collectionName: string, documentIds: Types.ObjectId[], session?: ClientSession): Promise<void> {
        await this.model.collection.updateMany(
            {company: companyId, collectionName, documentId: {$in: documentIds}},
            [{$set: {diff: {$arrayToObject: {$map: {input: {$objectToArray: {$ifNull: ["$diff", {}]}}, in: {k: "$$this.k", v: {from: null, to: null}}}}}}}],
            {session},
        );
    }
}

export const auditLogService = new AuditLogService();

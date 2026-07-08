import {Schema} from "mongoose";

/**
 * Audit Log Indexes
 * 
 * Optimized indexes for audit log queries.
 * Supports queries by document, collection, organization, and actor.
 */
export function applyAuditLogIndexes(AuditLogSchema: Schema): void {
    // Primary query pattern - audit logs by collection and document
    AuditLogSchema.index({ collectionName: 1, documentId: 1, createdAt: -1 });
    
    // For finding audit logs by organization
    AuditLogSchema.index({ organizationId: 1, createdAt: -1 });
    
    // For finding audit logs by actor
    AuditLogSchema.index({ actorId: 1, createdAt: -1 });
    
    // For finding audit logs by action type
    AuditLogSchema.index({ action: 1, createdAt: -1 });
    
    // Compound index for organization + actor queries
    AuditLogSchema.index({ organizationId: 1, actorId: 1, createdAt: -1 });
    
    // Compound index for collection + organization queries
    AuditLogSchema.index({ collectionName: 1, organizationId: 1, createdAt: -1 });
}

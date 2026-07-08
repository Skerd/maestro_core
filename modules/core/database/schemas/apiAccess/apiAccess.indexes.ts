import {Schema} from "mongoose";

/**
 * Raw ApiAccess events grow fast (one row per HTTP request). Long-term analytics
 * live in the time-bucketed `serverPerformance{1m|1h|1d}` collections, so the
 * raw rows are kept only for short-term forensics / audit.
 *
 * TTL: 7 days, applied on the standalone `createdAt` index.
 */
const RAW_TTL_SECONDS = 7 * 24 * 60 * 60;

export function applyApiAccessIndexes(ApiAccessSchema: Schema): void {
    // Tenant-scoped primary lookups
    ApiAccessSchema.index({ company: 1, endpoint: 1, method: 1 });   // Lookup by endpoint + method per company
    ApiAccessSchema.index({ company: 1, actionNumber: 1 });           // Lookup by action number per company

    // Time-range and recent access (company-scoped)
    ApiAccessSchema.index({ company: 1, createdAt: -1 });             // Recent access logs (newest first)
    ApiAccessSchema.index({ company: 1, createdAt: 1 });             // Oldest first for historical queries

    // Standalone TTL index — auto-expires raw access rows after RAW_TTL_SECONDS.
    // Note: TTL index is on a single-field `createdAt`; compound TTL is not supported by Mongo.
    ApiAccessSchema.index({ createdAt: 1 }, { expireAfterSeconds: RAW_TTL_SECONDS }); 

    // Filtering by status and performance
    ApiAccessSchema.index({ company: 1, statusCode: 1 });             // Filter by status code (e.g. errors)
    ApiAccessSchema.index({ company: 1, duration: -1 });               // Slowest requests first
    ApiAccessSchema.index({ company: 1, duration: 1 });               // Fastest requests first

    // By user/actor
    ApiAccessSchema.index({ company: 1, actionUser: 1, createdAt: -1 }); // Access by action user, recent first
    ApiAccessSchema.index({ company: 1, user: 1, createdAt: -1 });       // Access by target user, recent first

    // By device, IP, source (audit and filtering)
    ApiAccessSchema.index({ company: 1, requestIp: 1, createdAt: -1 }); // Access by IP, recent first
    ApiAccessSchema.index({ company: 1, deviceId: 1, createdAt: -1 });   // Access by device, recent first
    ApiAccessSchema.index({ company: 1, source: 1, createdAt: -1 });     // Access by source (e.g. web, mobile), recent first
    ApiAccessSchema.index({ company: 1, userAgent: 1, createdAt: -1 });  // Access by user agent (client type), recent first

    // Compound indexes for analytics and reporting
    ApiAccessSchema.index({ company: 1, endpoint: 1, createdAt: -1 });        // Endpoint usage over time
    ApiAccessSchema.index({ company: 1, statusCode: 1, createdAt: -1 });       // Error rate over time
    ApiAccessSchema.index({ company: 1, endpoint: 1, statusCode: 1 });         // Endpoint + status breakdown
}

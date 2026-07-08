import {Schema} from "mongoose";

export function applyMediaIndexes(MediaSchema: Schema): void {
    // Primary reference indexes
    MediaSchema.index({ createdBy: 1 });                // For finding media by creator (ownershipPlugin)
    MediaSchema.index({ fileId: 1 });                   // For GridFS file lookups (already indexed inline)

    // Type and file identification indexes
    MediaSchema.index({ type: 1 });                      // For filtering by media type (image, video, etc.)
    MediaSchema.index({ fileName: 1 });                  // For finding media by file name
    MediaSchema.index({ originalName: 1 });               // For finding media by original file name
    MediaSchema.index({ filePath: 1 });                  // For legacy file path lookups
    MediaSchema.index({ url: 1 });                       // For legacy URL lookups

    // Time-based indexes
    MediaSchema.index({ createdAt: -1 });                // For sorting by creation date (most recent first)
    MediaSchema.index({ createdAt: 1 });                 // For sorting by creation date (oldest first)
    MediaSchema.index({ uploadedAt: -1 });                // For sorting by upload date (most recent first)
    MediaSchema.index({ uploadedAt: 1 });                // For sorting by upload date (oldest first)

    // Legacy field indexes (for backward compatibility)
    MediaSchema.index({ mimeType: 1 });                  // For filtering by MIME type
    MediaSchema.index({ extension: 1 });                  // For filtering by file extension
    MediaSchema.index({ fileSize: -1 });                 // For sorting by file size (largest first)
    MediaSchema.index({ fileSize: 1 });                   // For sorting by file size (smallest first)

    // Metadata nested field indexes
    MediaSchema.index({ "metadata.mime": 1 });          // For filtering by MIME type from metadata
    MediaSchema.index({ "metadata.extension": 1 });      // For filtering by extension from metadata
    MediaSchema.index({ "metadata.size": -1 });          // For sorting by file size from metadata
    MediaSchema.index({ "metadata.safeCheckedFlag": 1 }); // For filtering by security scan status
    MediaSchema.index({ "metadata.scannedAt": -1 });     // For sorting by scan date
    MediaSchema.index({ "metadata.resolution.width": 1 }); // For filtering by width
    MediaSchema.index({ "metadata.resolution.height": 1 }); // For filtering by height
    MediaSchema.index({ "metadata.durationInSeconds": 1 }); // For filtering by duration

    // Compound indexes for common query patterns
    // createdBy-based compound indexes (most common)
    MediaSchema.index({ createdBy: 1, type: 1 });                           // User's media by type
    MediaSchema.index({ createdBy: 1, createdAt: -1 });                     // User's media sorted by creation date
    MediaSchema.index({ createdBy: 1, uploadedAt: -1 });                   // User's media sorted by upload date
    MediaSchema.index({ createdBy: 1, "metadata.safeCheckedFlag": 1 });     // User's media by security status
    MediaSchema.index({ createdBy: 1, type: 1, createdAt: -1 });           // User's media by type sorted by date

    // Type-based compound indexes
    MediaSchema.index({ type: 1, createdAt: -1 });                      // Media by type sorted by date
    MediaSchema.index({ type: 1, "metadata.size": -1 });                // Media by type sorted by size
    MediaSchema.index({ type: 1, "metadata.safeCheckedFlag": 1 });      // Media by type by security status

    // Security and scanning compound indexes
    MediaSchema.index({ "metadata.safeCheckedFlag": 1, createdAt: -1 }); // Unsafe media sorted by date
    MediaSchema.index({ "metadata.scannedAt": -1, "metadata.safeCheckedFlag": 1 }); // Scan status sorted by scan date

    // File identification compound indexes
    MediaSchema.index({ fileName: 1, createdBy: 1 });                        // File name with creator
    MediaSchema.index({ originalName: 1, createdBy: 1 });                    // Original name with creator
}

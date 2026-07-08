import {Schema} from "mongoose";

export function applyMessageIndexes(MessageSchema: Schema): void {
    // Primary query pattern for getMessages (sort by createdAt desc)
    MessageSchema.index({ channel: 1, createdAt: -1 });

    // For filtering active messages
    MessageSchema.index({ channel: 1, status: 1, createdAt: -1 });

    // For finding user's messages
    MessageSchema.index({ sender: 1, status: 1 });

    // For unread count queries
    MessageSchema.index({ channel: 1, createdAt: 1, status: 1 });

    // For reply queries
    MessageSchema.index({ replyTo: 1 });

    // For deleted message queries
    MessageSchema.index({ channel: 1, deletedFor: 1 });

    // For pinned messages
    MessageSchema.index({ channel: 1, pinned: 1, pinnedAt: -1 });

    // For user reactions
    MessageSchema.index({ "reactions.user": 1 }); // For finding reactions by user

    // For mention queries
    MessageSchema.index({ mentionedUsers: 1 });

    // For read receipt queries
    MessageSchema.index({ "readBy.userId": 1 });

    // For text search (if MongoDB text search enabled)
    MessageSchema.index({ channel: 1, text: "text" });

    // Additional indexes for common query patterns
    MessageSchema.index({ sender: 1, channel: 1 });                        // User's messages in a channel
    MessageSchema.index({ sender: 1, createdAt: -1 });                    // User's messages sorted by date
    MessageSchema.index({ channel: 1, type: 1, createdAt: -1 });          // Channel messages by type
    MessageSchema.index({ status: 1, createdAt: -1 });                    // Messages by status sorted by date
    MessageSchema.index({ pinned: 1, pinnedAt: -1 });                     // Pinned messages sorted by pin date
    MessageSchema.index({ channel: 1, status: 1 });                       // Channel messages by status
    MessageSchema.index({ "deletedFor._id": 1 });                         // Messages deleted for a user
    MessageSchema.index({ mediaIds: 1 });                                  // Messages with media attachments
    MessageSchema.index({ actionUser: 1 });                                 // Messages with action users
}

import {Schema} from "mongoose";

export function applyChannelIndexes(ChannelSchema: Schema): void {
    // Primary query pattern for userChannels
    ChannelSchema.index({ company: 1, deleted: 1, users: 1 });

    // For leftUsers queries
    ChannelSchema.index({ company: 1, deleted: 1, "leftUsers._id": 1, "leftUsers.showChannel": 1 });

    // For group channel queries
    ChannelSchema.index({ company: 1, deleted: 1, isGroup: 1, users: 1 });

    // For owner-based queries
    ChannelSchema.index({ company: 1, deleted: 1, owner: 1 });

    // For admin queries
    ChannelSchema.index({ company: 1, deleted: 1, adminUsers: 1 });

    // Compound for add/remove members
    ChannelSchema.index({ company: 1, deleted: 1, isGroup: 1, adminUsers: 1 });

    // For sorting by lastAction
    ChannelSchema.index({ lastAction: -1 });

    // For finding existing direct message channels
    ChannelSchema.index({ company: 1, isGroup: 1, users: 1, deleted: 1 });

    // For pinned messages queries
    ChannelSchema.index({ pinnedMessages: 1 });

    // For order-scoped channels (eCommerce)
    ChannelSchema.index({ "metadata.orderId": 1 });

    // Additional indexes for common query patterns
    ChannelSchema.index({ company: 1, deleted: 1, lastAction: -1 });        // Company channels sorted by activity
    ChannelSchema.index({ owner: 1, deleted: 1 });                        // Owner's channels
    ChannelSchema.index({ users: 1, deleted: 1 });                          // User's channels
    ChannelSchema.index({ isGroup: 1, deleted: 1 });                       // Group channels
    ChannelSchema.index({ createdAt: -1 });                                // Channels sorted by creation date
}

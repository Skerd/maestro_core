import {Schema} from "mongoose";

export function applyLastChannelReadMessageIndexes(LastChannelReadMessageSchema: Schema): void {
    // Primary reference indexes
    LastChannelReadMessageSchema.index({ user: 1 });              // For finding read messages by user
    LastChannelReadMessageSchema.index({ channel: 1 });            // For finding read messages by channel

    // Time-based indexes
    LastChannelReadMessageSchema.index({ time: -1 });              // For sorting by read time (most recent first)
    LastChannelReadMessageSchema.index({ time: 1 });              // For sorting by read time (oldest first)

    // Compound indexes for common query patterns
    LastChannelReadMessageSchema.index({ user: 1, channel: 1 });           // User's read time for a specific channel
    LastChannelReadMessageSchema.index({ user: 1, channel: 1 }, { unique: true }); // Ensure one read record per user-channel
    LastChannelReadMessageSchema.index({ user: 1, time: -1 });               // User's read messages sorted by time
    LastChannelReadMessageSchema.index({ channel: 1, time: -1 });            // Channel's read messages sorted by time
    LastChannelReadMessageSchema.index({ channel: 1, user: 1, time: -1 });  // Channel read status for users
}

import {objectIds as ids, registerPersonEraser, type ErasureContext, type ErasureCount} from "@coreModule/utilities/erasure/personErasure";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {messageService} from "@coreModule/database/schemas/message/message.service";
import {lastChannelReadMessageService} from "@coreModule/database/schemas/lastChannelReadMessage/lastChannelReadMessage.service";

/**
 * Core's records of one person in a company (D57): their website chats (by the visitor's email or signed-in account)
 * are deleted with their messages, read markers and attachments; nothing needs keeping. Staff-to-staff chats are the
 * staff's and are not touched.
 */
async function eraseCorePerson(ctx: ErasureContext): Promise<ErasureCount[]> {
    const {companyId, subject, preview, session} = ctx;
    const found = {session, withDeleted: true};

    const channels = await channelService.find({
        company: companyId,
        isPublicChat: true,
        $or: [{"publicChat.customer": {$in: subject.accountIds}}, {"publicChat.visitor.email": {$in: subject.emails}}],
    }, found, undefined, "_id");
    const channelIds = ids(channels);
    const messages = channelIds.length > 0 ? await messageService.find({company: companyId, channel: {$in: channelIds}}, found, undefined, "_id mediaIds") : [];
    ctx.deleteMedia(messages.flatMap((message) => ids(message.mediaIds)));

    const counts: ErasureCount[] = [
        {collection: "channels", anonymised: 0, deleted: channels.length},
        {collection: "messages", anonymised: 0, deleted: messages.length},
    ];
    if (preview || channelIds.length === 0) return counts;

    await messageService.deleteMany({company: companyId, channel: {$in: channelIds}}, {session, hard: true});
    await lastChannelReadMessageService.deleteMany({company: companyId, channel: {$in: channelIds}}, {session, hard: true});
    await channelService.deleteMany({company: companyId, _id: {$in: channelIds}}, {session, hard: true});
    ctx.scrubAudit("messages", ids(messages), "all");
    ctx.scrubAudit("channels", channelIds, "all");
    return counts;
}

export function registerCorePersonErasers(): void {
    registerPersonEraser({module: "core", erase: eraseCorePerson});
}

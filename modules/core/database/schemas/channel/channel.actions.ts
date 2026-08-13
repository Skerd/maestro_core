import {ObjectId} from "mongodb";
import {action} from "@coreModule/api/actionDecorator";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import Channel, {IChannel} from "@coreModule/database/schemas/channel/channel";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {setPublicChatStatus} from "@coreModule/database/schemas/channel/channel.helper";
import {
    assignAgentToPublicChat,
    releasePublicChatToBot,
} from "@coreModule/domain/publicChat/handoff";
import {agentDisplayName} from "@coreModule/utilities/mappers/channel/publicChatMapper.dto";
import {channelToDTO} from "@coreModule/utilities/mappers/channel/channelMapper.dto";
import type {Channel as ChannelDTO} from "armonia/src/modules/core/api/user/private/chats/channels/channels.form.response.type";
import type {ActionMessage, SingleForm} from "armonia/src/modules/core/types/shared.types";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";
import {schemaSanitizer} from "@coreModule/utilities/middlewares/schemaSanitizerMW";

type ChannelActionParams = SingleForm & Record<string, any>;

async function requirePublicChat(
    channelId: string,
    companyId: ObjectId,
    logger: ChannelActionParams["logger"],
    languageCode: string,
): Promise<IChannel> {
    const channel = await channelService.findOne(
        {_id: new ObjectId(channelId), company: companyId, isPublicChat: true},
        {logger, languageCode},
        ["users", "adminUsers", "owner", "leftUsers.user", "publicChat.assignedTo"],
    );
    if (!channel) {
        throw apiValidationException("visitor_session_not_found", "_id", null, languageCode);
    }
    return channel;
}

function visitorIdOf(channel: IChannel): ObjectId {
    const owner = (channel.aiOwnerUser as any)?._id ?? channel.aiOwnerUser;
    return new ObjectId(owner.toString());
}

export class ChannelActions {

    /**
     * POST /api/user/chats/channels/join — take over a website visitor chat.
     */
    @action({
        auth: "private",
        rateLimit: {windowMs: 60000, max: 60},
        middleware: [schemaSanitizer({model: "channels", requiredModes: ["read"]})],
        schema: validateSingleForm,
    })
    async join(params: ChannelActionParams): Promise<ChannelDTO> {
        const {company, actionUserInfo, actionUserCtx, languageCode, logger, _id} = params;
        logger.start(`Agent ${actionUserInfo._id.toString()} joining public chat ${_id}...`);

        SchemaGuard.sanitizeFields(Channel, {users: {}}, "write", actionUserCtx, languageCode);

        const channel = await requirePublicChat(_id, company._id, logger, languageCode);

        const assignedTo = (channel.publicChat?.assignedTo as any)?._id ?? channel.publicChat?.assignedTo;
        if (assignedTo && assignedTo.toString() !== actionUserInfo._id.toString()) {
            throw apiValidationException("public_chat_already_assigned", "_id", null, languageCode);
        }

        await assignAgentToPublicChat({
            channel,
            agentId: actionUserInfo._id,
            agentDisplayName: agentDisplayName(actionUserInfo),
            visitorId: visitorIdOf(channel),
            languageCode,
            logger,
        });

        const refreshed = await requirePublicChat(_id, company._id, logger, languageCode);
        const dto = await channelToDTO(refreshed, actionUserInfo._id.toString(), actionUserCtx);
        if (!dto) {
            throw apiValidationException("visitor_session_not_found", "_id", null, languageCode);
        }
        logger.finish(`Agent joined public chat ${_id}`);
        return dto;
    }

    /**
     * POST /api/user/chats/channels/release — hand a website chat back to the bot.
     */
    @action({
        auth: "private",
        rateLimit: {windowMs: 60000, max: 60},
        schema: validateSingleForm,
    })
    async release(params: ChannelActionParams): Promise<ActionMessage> {
        const {company, actionUserInfo, actionUserCtx, languageCode, logger, _id} = params;
        logger.start(`Releasing public chat ${_id} back to the bot...`);

        SchemaGuard.sanitizeFields(Channel, {users: {}}, "write", actionUserCtx, languageCode);
        const channel = await requirePublicChat(_id, company._id, logger, languageCode);

        await releasePublicChatToBot({
            channel,
            agentId: actionUserInfo._id,
            visitorId: visitorIdOf(channel),
            languageCode,
            logger,
        });

        logger.finish(`Public chat ${_id} released`);
        return {message: "Public chat released to bot"};
    }

    /**
     * POST /api/user/chats/channels/close — end a website visitor conversation.
     */
    @action({
        auth: "private",
        rateLimit: {windowMs: 60000, max: 60},
        schema: validateSingleForm,
    })
    async close(params: ChannelActionParams): Promise<ActionMessage> {
        const {company, actionUserInfo, actionUserCtx, languageCode, logger, _id} = params;
        logger.start(`Closing public chat ${_id}...`);

        SchemaGuard.sanitizeFields(Channel, {users: {}}, "write", actionUserCtx, languageCode);
        await requirePublicChat(_id, company._id, logger, languageCode);

        await setPublicChatStatus({
            channelId: new ObjectId(_id),
            status: "closed",
            languageCode,
            logger,
            auditUserId: actionUserInfo._id.toString(),
        });

        logger.finish(`Public chat ${_id} closed`);
        return {message: "Public chat closed"};
    }
}

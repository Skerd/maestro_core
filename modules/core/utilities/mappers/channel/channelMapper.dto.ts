import Message, {IMessage} from "@coreModule/database/schemas/message/message";
import {IChannel} from "@coreModule/database/schemas/channel/channel";
import LastChannelReadMessage from "@coreModule/database/schemas/lastChannelReadMessage/lastChannelReadMessage";
import {Channel} from "armonia/src/modules/core/api/user/private/chats/channels/channels.form.response.type";
import {messageService} from "@coreModule/database/schemas/message/message.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {ChannelUser} from "armonia/src/modules/core/types";
import {UserContext} from "@coreModule/utilities/types/types";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {messageToDTO} from "@coreModule/utilities/mappers/message/messageMapper.dto";
import {COLLECTED_DATA} from "@coreModule/database/collections";

export async function channelToDTO(channel: IChannel, actionUserId: string, actionUserCtx: UserContext): Promise<Channel | null> {

    let sanitizedFields = SchemaGuard.sanitizeFields(Message, COLLECTED_DATA["messages"].readFields, "read", actionUserCtx);
    let populate = SchemaGuard.generatePopulate(sanitizedFields, Message.schema);

    const [lastChannelReadResult, lastMessagesResult] = await Promise.allSettled([
        LastChannelReadMessage.findOne({channel: channel._id, user: actionUserId}),
        messageService.find(
            {
                channel: channel._id,
                deletedFor: {
                    $not: {
                        $elemMatch: {
                            user: new Object(actionUserId),
                            showMessage: false
                        }
                    }
                }
            },
            {},
            populate.populate,
            (populate.select || "") + "channel",
            {
                createdAt: -1
            },
            1
        )
    ]);

    const lastChannelRead = lastChannelReadResult.status === "fulfilled" ? lastChannelReadResult.value : null;
    const lastMessages = lastMessagesResult.status === "fulfilled" ? lastMessagesResult.value : [];

    let time = new Date(0);
    if( lastChannelRead ){
        time = lastChannelRead.time;
    }

    const actionUserLeft = channel.leftUsers?.find(user => user.user.toString() === actionUserId);
    const myLeaveTime = actionUserLeft ? actionUserLeft.time.getTime() : 0;

    const unreadInChannelPromise = messageService.count({
        channel: channel._id,
        createdAt: {
            $gt: time
        },
        status: {$in: ["active", "edited"]},
        deletedFor: {
            $not: {
                $elemMatch: {
                    user: new Object(actionUserId),
                    showMessage: false
                }
            }
        }
    });

    let lastMessage: IMessage | undefined = undefined;
    if( lastMessages.length ){
        lastMessage = lastMessages[0];
    }

    if(!!lastMessage && ((lastMessage.deletedFor || []).some(deletedFor => deletedFor.user.toString() === actionUserId && deletedFor.showMessage === false ))){
        lastMessage = null;
    }

    let lastMessagePromise: Promise<any> | null = null;
    if( !!lastMessage ){
        try{
            lastMessagePromise = messageService.findById(
                lastMessage._id,
                {},
                populate.populate,
                (populate.select || ""),
            ).then((message) => messageToDTO(message, actionUserId));
        }catch (e){}
    }

    const userMap = new Map<string, ChannelUser>();
    for (const user of (channel.users || [])) {
        const id = String(user._id);
        if (!userMap.has(id)) {
            let userType: "user" | "admin" | "owner" | undefined = "user";
            if( !!channel.adminUsers && !!channel.adminUsers?.length ){
                if( (channel.adminUsers || []).some(admin => admin._id.toString() === id) ){
                    userType = "admin";
                }
            }
            if( !!channel.owner ){
                if( channel.owner._id.toString() === id ){
                    userType = "owner";
                }
            }
            if( !channel.adminUsers && !channel.owner ){
                userType = undefined;
            }

            userMap.set(id, {
                _id: id,
                name: user.name,
                surname: user.surname,
                userType,
                photo: user.photo?._id?.toString()
            });
        }
    }

    const leftUserMap = new Map<string, ChannelUser>();
    for (const leftUserData of (channel.leftUsers || [])) {
        let user = leftUserData.user;

        const id = String(user._id);
        if (!leftUserMap.has(id)) {
            leftUserMap.set(id, {
                _id: id,
                name: user.name,
                surname: user.surname,
                photo: user.photo?._id?.toString()
            });
        }
    }

    let leftUsersPromise: Promise<any[]> | null = null;
    if( !!actionUserLeft ){
        const leftUserIds = (channel.leftUsers || []).filter(lu => lu.time.getTime() > myLeaveTime).map(lu => String(lu.user));
        const uniqueLeftIds = [...new Set(leftUserIds)];

        if (uniqueLeftIds.length > 0) {
            leftUsersPromise = userService.find(
                { _id: { $in: uniqueLeftIds } },
                {},
                null,
                "name surname fullName photo"
            );
        }
    }

    try{
        const unreadInChannel = await unreadInChannelPromise;
        const leftUsers = leftUsersPromise ? await leftUsersPromise : [];
        for (const user of (leftUsers || [])) {
            const id = String(user._id);
            if (!userMap.has(id)) {

                let userType: "user" | "admin" | "owner" | undefined = "user";
                if( !!channel.adminUsers && !!channel.adminUsers?.length ){
                    if( (channel.adminUsers || []).some(admin => admin._id.toString() === id) ){
                        userType = "admin";
                    }
                }
                if( !!channel.owner ){
                    if( channel.owner._id.toString() === id ){
                        userType = "owner";
                    }
                }
                if( !channel.adminUsers && !channel.owner ){
                    userType = undefined;
                }

                userMap.set(id, {
                    _id: id,
                    name: user.name,
                    surname: user.surname,
                    userType,
                    photo: user.photo?._id?.toString()
                });
            }
        }

        const orderId = (channel as any).metadata?.orderId?.toString?.();
        let returnThis: Channel = {
            _id: channel._id.toString(),
            name: channel.name && channel.name,
            users: channel.users && [...userMap.values()],
            ...(orderId ? { orderId } : {}),
            metaData: {
                isGroup: channel.isGroup,
                readOnly: !!actionUserLeft,
                unreadMessages: unreadInChannel,
                lastUserReadTime: time,
                isAiAssistant: !!channel.isAiAssistant
            }
        };

        if( lastMessagePromise ){
            try{
                returnThis.metaData["lastMessage"] = await lastMessagePromise;
            }catch (e){}
        }
        return returnThis;
    }
    catch(error){
        return null;
    }

}

export async function channelsToDTO(channels: IChannel[], actionUserId: string, actionUserCtx: UserContext): Promise<Channel[]> {
    const results = await Promise.allSettled(channels.map((channel) => channelToDTO(channel, actionUserId, actionUserCtx)));
    return results.filter((result) => result.status === "fulfilled" && result.value != null).map((result) => (result as PromiseFulfilledResult<Channel>).value);
}
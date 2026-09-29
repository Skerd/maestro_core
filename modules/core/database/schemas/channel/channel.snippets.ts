import type {ChannelLeadChat, ChannelSimple} from "armonia/src/modules/core/dto/channel.dto";
import type {IChannel} from "@coreModule/database/schemas/channel/channel";
import {defineSnippet} from "@coreModule/database/utilities/snippet";

export const ChannelSimpleSnippet = defineSnippet<IChannel, ChannelSimple>()({
    keys: {
        _id: {},
        name: {},
    },
});

/** Lead sheet/table: show visitor label and keep enough shape for chat deep-links. */
export const ChannelLeadChatSnippet = defineSnippet<IChannel, ChannelLeadChat>()({
    keys: {
        _id: {},
        name: {},
        publicChat: {
            keys: {
                visitor: {
                    keys: {
                        displayName: {},
                    },
                },
            },
        },
    },
});

export const ChannelSimpleSnippet = {
    keys: {
        name: {}
    }
}

/** Lead sheet/table: show visitor label and keep enough shape for chat deep-links. */
export const ChannelLeadChatSnippet = {
    keys: {
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
};
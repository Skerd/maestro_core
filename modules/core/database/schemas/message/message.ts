import {IUser} from "@coreModule/database/schemas/user/user";
import mongoose, {Document, SchemaTypes} from "mongoose";
import {IMedia} from "@coreModule/database/schemas/media/media";
import {applyMessageIndexes} from "./message.indexes";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import {IOwnershipPluginFields} from "@coreModule/database/types/plugin-fields";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import {ObjectId} from "mongodb";
import {IChannel} from "@coreModule/database/schemas/channel/channel";
import {addModelData} from "@coreModule/database/collections";
import {ChannelSimpleSnippet} from "@coreModule/database/schemas/channel/channel.snippets";
import {SimpleUserSnippet} from "@coreModule/database/schemas/user/user.snippets";
import {ReplyToMessageSnippet} from "@coreModule/database/schemas/message/message.snippets";
import {MediaSimpleSnippet} from "@coreModule/database/schemas/media/media.snippets";

export interface IMessage extends Document, IOwnershipPluginFields {
    channel: IChannel;
    sender: IUser;
    receiver: IUser;
    text: string;
    forwardedText?: string;
    mediaIds?: IMedia[];
    status?: "active" | "deleted" | "edited";
    type: "message" | "notification";
    // reply
    replyTo?: IMessage;
    // reactions
    reactions?: {
        _id: ObjectId,
        emoji: string;
        user: IUser;
        date: Date;
    }[];
    // pinned
    pinned: {
        date: Date;
        user: IUser;
    }
    // mentions
    mentionedUsers?: IUser[];
    // delivery
    delivery: {
        user: IUser;
        readDate: Date;
        date: Date
    }[];
    // deleted
    deletedFor: {
        user: IUser,
        time: Date,
        showMessage: boolean
    }[]

    deletedAt: Date,
    createdAt: Date;
    updatedAt: Date;
}

export const MessageSchema = new mongoose.Schema<IMessage>(
    {
        channel: {
            type: SchemaTypes.ObjectId,
            ref: "Channel",
            permissions: {
                self: {
                    read: "no-permission",
                    write: "no-permission"
                },
                others: {
                    read: "no-permission",
                    write: "no-permission"
                }
            },
            refAllowlist: ChannelSimpleSnippet
        },
        sender: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {
                    write: "no-permission"
                }
            },
            refAllowlist: SimpleUserSnippet
        },
        receiver: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {
                    write: "no-permission"
                }
            },
            refAllowlist: SimpleUserSnippet
        },
        text: {
            type: SchemaTypes.String
        },
        forwardedText: {
            type: SchemaTypes.String,
        },
        mediaIds: {
            type: [SchemaTypes.ObjectId],
            ref: "Media",
            refAllowlist: MediaSimpleSnippet
        },
        status: {
            type: SchemaTypes.String,
            enum: ["active", "deleted", "edited"],
            default: "active",
            permissions: {
                self: {
                    read: "no-permission",
                    write: "no-permission"
                },
                others: {
                    read: "no-permission",
                    write: "no-permission"
                }
            }
        },
        type: {
            type: SchemaTypes.String,
            enum: ["message", "notification"],
            default: "message",
            permissions: {
                self: {
                    read: "no-permission",
                    write: "no-permission"
                },
                others: {
                    read: "no-permission",
                    write: "no-permission"
                }
            }
        },

        // reply
        replyTo: {
            type: SchemaTypes.ObjectId,
            ref: "Message",
            required: false,
            refAllowlist: ReplyToMessageSnippet
        },
        // reactions
        reactions: [{
            type: {
                emoji: {
                    type: SchemaTypes.String,
                    required: true,
                    permissions: {
                        self: {
                            write: "no-permission"
                        },
                        others: {
                            write: "no-permission"
                        }
                    }
                },
                user: {
                    type: SchemaTypes.ObjectId,
                    ref: "User",
                    required: true,
                    permissions: {
                        self: {
                            write: "no-permission"
                        },
                        others: {
                            write: "no-permission"
                        }
                    },
                    refAllowlist: SimpleUserSnippet
                },
                date: {
                    type: SchemaTypes.Date,
                    required: true,
                    default: Date.now,
                    permissions: {
                        self: {
                            write: "no-permission"
                        },
                        others: {
                            write: "no-permission"
                        }
                    }
                }
            },
            default: []
        }],
        // pinned
        pinned: {
            type: {
                date: {
                    type: SchemaTypes.Date,
                    required: true,
                    permissions: {
                        self: {
                            write: "no-permission"
                        },
                        others: {
                            write: "no-permission"
                        }
                    }
                },
                user: {
                    type: SchemaTypes.ObjectId,
                    ref: "User",
                    required: true,
                    permissions: {
                        self: {
                            write: "no-permission"
                        },
                        others: {
                            write: "no-permission"
                        }
                    },
                    refAllowlist: SimpleUserSnippet
                },
            }
        },
        // mentions
        mentionedUsers: {
            type: [{
                type: SchemaTypes.ObjectId,
                ref: "User",
                refAllowlist: SimpleUserSnippet
            }]
        },
        // delivery
        delivery: [{
            type: {
                user: {
                    type: SchemaTypes.ObjectId,
                    ref: "User",
                    required: true,
                    refAllowlist: SimpleUserSnippet
                },
                readDate: {
                    type: SchemaTypes.Date
                },
                date: {
                    type: SchemaTypes.Date,
                    required: true
                }
            }
        }],
        // deleted
        deletedFor: {
            type: [{
                user: {
                    type: SchemaTypes.ObjectId,
                    ref: "User",
                    required: true,
                    permissions: {
                        self: {
                            read: "no-permission",
                            write: "no-permission"
                        },
                        others: {
                            read: "no-permission",
                            write: "no-permission"
                        }
                    },
                    refAllowlist: SimpleUserSnippet
                },
                time: {
                    type: Date,
                    required: true,
                    default: Date.now,
                    permissions: {
                        self: {
                            read: "no-permission",
                            write: "no-permission"
                        },
                        others: {
                            read: "no-permission",
                            write: "no-permission"
                        }
                    }
                },
                showMessage: {
                    type: SchemaTypes.Boolean,
                    required: true,
                    default: false,
                    permissions: {
                        self: {
                            read: "no-permission",
                            write: "no-permission"
                        },
                        others: {
                            read: "no-permission",
                            write: "no-permission"
                        }
                    }
                }
            }],
            permissions: {
                self: {
                    read: "no-permission",
                    write: "no-permission"
                },
                others: {
                    read: "no-permission",
                    write: "no-permission"
                }
            }
        },
        deletedAt: {
            type: SchemaTypes.Date,
            permissions: {
                self: {
                    read: "no-permission",
                    write: "no-permission"
                },
                others: {
                    read: "no-permission",
                    write: "no-permission"
                }
            }
        },
        createdAt: {
            type: SchemaTypes.Date,
            default: Date.now,
            required: true,
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {
                    write: "no-permission"
                }
            }
        }
    },
    {
        permissions: {
            self: {},
            others: {}
        }
    }
);

ownershipPlugin(MessageSchema);
auditPlugin(MessageSchema);
// softDeletePlugin(MessageSchema);
applyMessageIndexes(MessageSchema);
// Message.syncIndexes(); // Uncomment to manually sync indexes

const Message = mongoose.model<IMessage>("Message", MessageSchema);
normalizeSchemaPermissions(Message);
export default Message;

addModelData(Message);
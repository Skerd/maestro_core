import {IUser} from "@coreModule/database/schemas/user/user";
import {ICompany} from "@coreModule/database/schemas/company/company";
import mongoose, {Document, SchemaTypes} from "mongoose";
import {ObjectId} from "mongodb";
import {applyChannelIndexes} from "./channel.indexes";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import {IOwnershipPluginFields} from "@coreModule/database/types/plugin-fields";
import {addModelData} from "@coreModule/database/collections";
import {SimpleUserSnippet} from "@coreModule/database/schemas/user/user.snippets";
import {ILead} from "@propertyManagement/database/schemas/lead/lead";
import {IProject} from "@propertyManagement/database/schemas/project/project";
import {IUnit} from "@propertyManagement/database/schemas/unit/unit";

/**
 * Lifecycle of a public visitor chat.
 * - `bot` — the assistant answers every visitor message.
 * - `requested_human` — escalated (by the visitor or by the bot's own `request_human_agent` tool); AI dispatch stops.
 * - `human` — an agent took over; AI dispatch stays off.
 * - `closed` — read-only; a new visitor session starts a new channel.
 */
export type PublicChatStatus = "bot" | "requested_human" | "human" | "closed";

export const PUBLIC_CHAT_STATUS_VALUES: PublicChatStatus[] = ["bot", "requested_human", "human", "closed"];

/** Visitor metadata and handoff state carried by a public chat channel. */
export interface IPublicChatMeta {
    status: PublicChatStatus,
    assignedTo?: IUser,
    lead?: ILead,
    visitor: {
        displayName?: string,
        email?: string,
        phone?: string,
        ip?: string,
        userAgent?: string,
        entryUrl?: string,
        referrer?: string,
    },
    context?: {
        project?: IProject,
        unit?: IUnit,
    },
    lastVisitorActivity: Date,
    handoffRequestedAt?: Date,
    closedAt?: Date,
}

export interface IChannel extends Document, IOwnershipPluginFields {
    users: IUser[],

    owner: IUser,
    company: ICompany,
    name: string,
    description?: string,
    avatar?: ObjectId,
    isGroup: boolean,
    isAiAssistant: boolean,
    aiOwnerUser?: IUser,
    isPublicChat: boolean,
    publicChat?: IPublicChatMeta,
    adminUsers: IUser[],
    leftUsers: {
        user: IUser,
        time: Date,
        showChannel: boolean
    }[],
    pinnedMessages?: ObjectId[],
    lastAction: Date,
    createdAt: Date,
}

export const ChannelSchema = new mongoose.Schema<IChannel>(
    {
        users: {
            type: [SchemaTypes.ObjectId],
            ref: "User",
            default: [],
            refAllowlist: SimpleUserSnippet
        },
        owner: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            permissions: {
                self: {
                    write: "no-permission",
                },
                others: {
                    write: "no-permission",
                }
            },
            refAllowlist: SimpleUserSnippet
        },
        name: {
            type: SchemaTypes.String,
            default: ""
        },
        description: {
            type: SchemaTypes.String,
            required: false
        },
        avatar: {
            type: SchemaTypes.ObjectId,
            ref: "Media",
            required: false
        },
        isGroup: {
            type: SchemaTypes.Boolean,
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
        },
        isAiAssistant: {
            type: SchemaTypes.Boolean,
            default: false,
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {
                    write: "no-permission"
                }
            }
        },
        aiOwnerUser: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            required: false,
            default: null,
            refAllowlist: SimpleUserSnippet,
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {
                    write: "no-permission"
                }
            }
        },
        isPublicChat: {
            type: SchemaTypes.Boolean,
            default: false,
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {
                    write: "no-permission"
                }
            }
        },
        publicChat: {
            type: {
                status: {
                    type: SchemaTypes.String,
                    enum: PUBLIC_CHAT_STATUS_VALUES,
                    default: "bot"
                },
                assignedTo: {
                    type: SchemaTypes.ObjectId,
                    ref: "User",
                    required: false,
                    default: null,
                    refAllowlist: SimpleUserSnippet
                },
                lead: {
                    type: SchemaTypes.ObjectId,
                    required: false,
                    default: null
                },
                visitor: {
                    type: {
                        displayName: {
                            type: SchemaTypes.String,
                            required: false
                        },
                        email: {
                            type: SchemaTypes.String,
                            required: false
                        },
                        phone: {
                            type: SchemaTypes.String,
                            required: false
                        },
                        ip: {
                            type: SchemaTypes.String,
                            required: false
                        },
                        userAgent: {
                            type: SchemaTypes.String,
                            required: false
                        },
                        entryUrl: {
                            type: SchemaTypes.String,
                            required: false
                        },
                        referrer: {
                            type: SchemaTypes.String,
                            required: false
                        }
                    },
                },
                context: {
                    type: {
                        project: {
                            type: SchemaTypes.ObjectId,
                            ref: "Project",
                            required: false
                        },
                        unit: {
                            type: SchemaTypes.ObjectId,
                            ref: "Unit",
                            required: false
                        }
                    },
                    required: false
                },
                lastVisitorActivity: {
                    type: SchemaTypes.Date,
                    default: Date.now
                },
                handoffRequestedAt: {
                    type: SchemaTypes.Date,
                    required: false
                },
                closedAt: {
                    type: SchemaTypes.Date,
                    required: false
                }
            },
            required: false,
            default: null,
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {
                    write: "no-permission"
                }
            }
        },
        pinnedMessages: [{
            type: SchemaTypes.ObjectId,
            ref: "Message"
        }],
        adminUsers: {
            type: [SchemaTypes.ObjectId],
            ref: "User",
            default: [],
            refAllowlist: SimpleUserSnippet
        },
        leftUsers: {
            type: [{
                user: {
                    type: SchemaTypes.ObjectId,
                    ref: "User",
                    required: true ,
                    refAllowlist: SimpleUserSnippet
                },
                time: {
                    type: Date,
                    required: true
                },
                showChannel: {
                    type: Boolean,
                    required: true
                }
            }]
        },
        lastAction: {
            type: SchemaTypes.Date,
            default: Date.now,
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {
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
        // No softDeletePlugin: leaving updates `leftUsers`; the channel document stays.
        // Last member leaving still hard-deletes via the service. Model `delete` stays —
        // SchemaGuard gates leave/delete. Restore has no API.
        permissions: {
            self: {
                restore: "no-permission",
            },
            others: {
                restore: "no-permission",
            }
        }
    }
);

ownershipPlugin(ChannelSchema);
auditPlugin(ChannelSchema);
// No softDeletePlugin / lifeCyclePlugin: membership is `users` + `leftUsers`.
// `createdAt` is a channel field, not the lifecycle plugin. Model restore is no-permission.
applyChannelIndexes(ChannelSchema);
// Channel.syncIndexes(); // Uncomment to manually sync indexes

const Channel = mongoose.model<IChannel>("Channel", ChannelSchema);
normalizeSchemaPermissions(Channel);
export default Channel;

addModelData(Channel);

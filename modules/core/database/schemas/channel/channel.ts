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

export interface IChannel extends Document, IOwnershipPluginFields {
    users: IUser[],

    owner: IUser,
    company: ICompany,
    name: string,
    description?: string,
    avatar?: ObjectId,
    isGroup: boolean,
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
        permissions: {
            self: {},
            others: {}
        }
    }
);

ownershipPlugin(ChannelSchema);
auditPlugin(ChannelSchema);
applyChannelIndexes(ChannelSchema);
// Channel.syncIndexes(); // Uncomment to manually sync indexes

const Channel = mongoose.model<IChannel>("Channel", ChannelSchema);
normalizeSchemaPermissions(Channel);
export default Channel;

addModelData(Channel);

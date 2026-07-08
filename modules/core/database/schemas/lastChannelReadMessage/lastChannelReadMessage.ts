import {IUser} from "@coreModule/database/schemas/user/user";
import mongoose, {Document, SchemaTypes} from "mongoose";
import {applyLastChannelReadMessageIndexes} from "./lastChannelReadMessage.indexes";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import {IOwnershipPluginFields} from "@coreModule/database/types/plugin-fields";
import {IChannel} from "@coreModule/database/schemas/channel/channel";

export interface ILastChannelReadMessage extends Document, IOwnershipPluginFields {
    user: IUser,
    channel: IChannel,
    time: Date
}

export const LastChannelReadMessageSchema = new mongoose.Schema<ILastChannelReadMessage>({
    user: {
        type: SchemaTypes.ObjectId,
        ref: "User",
        permissions: {
            self: {
                read: "no-permission",
                write: "no-permission",
            },
            others: {
                read: "no-permission",
                write: "no-permission",
            }
        }
    },
    channel: {
        type: SchemaTypes.ObjectId,
        ref: "Channel",
        permissions: {
            self: {
                read: "no-permission",
                write: "no-permission",
            },
            others: {
                read: "no-permission",
                write: "no-permission",
            }
        }
    },
    time: {
        type: SchemaTypes.Date,
        permissions: {
            self: {
                read: "no-permission",
                write: "no-permission",
            },
            others: {
                read: "no-permission",
                write: "no-permission",
            }
        }
    }
}, {
    permissions: {
        self: {
            create: "no-permission",
            delete: "no-permission",
            restore: "no-permission"
        },
        others: {
            create: "no-permission",
            delete: "no-permission",
            restore: "no-permission"
        }
    }
});

auditPlugin(LastChannelReadMessageSchema);
applyLastChannelReadMessageIndexes(LastChannelReadMessageSchema);
const LastChannelReadMessage = mongoose.model<ILastChannelReadMessage>("LastChannelReadMessage", LastChannelReadMessageSchema);
normalizeSchemaPermissions(LastChannelReadMessage);
export default LastChannelReadMessage;
// LastChannelReadMessage.syncIndexes(); // Uncomment to manually sync indexes

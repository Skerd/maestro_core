import mongoose, {Document, SchemaTypes} from "mongoose";
import {applyNotificationIndexes} from "./notification.indexes";
import {IUser} from "@coreModule/database/schemas/user/user";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import {IOwnershipPluginFields} from "@coreModule/database/types/plugin-fields";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import {
    NotificationCategory as NotificationCategoryEnum,
    NotificationDeliveryChannel as NotificationDeliveryChannelEnum
} from "armonia/src/modules/core/api/user/private/notifications/notifications.enum";
import {addModelData} from "@coreModule/database/collections";
import {SimpleUserSnippet} from "@coreModule/database/schemas/user/user.snippets";

export enum NotificationImportance {
    LOW = "low",
    NORMAL = "normal",
    MEDIUM = "medium",
    HIGH = "high",
    CRITICAL = "critical"
}

export enum NotificationStatus {
    Success = "success",
    Error = "error",
    Warning = "warning",
    Info = "info"
}

export interface INotification extends Document, IOwnershipPluginFields {
    sender: IUser,
    receiver: IUser,
    company: ICompany,
    code: string,
    description?: string,
    content?: any,
    extraMessages: any[],

    date: Date,
    importance: NotificationImportance,
    status: NotificationStatus,
    readOn?: Date,
    category?: string,
    channels?: string[],
    metadata?: Record<string, unknown>,
    read: () => void,
    isRead: () => boolean,
    addExtraMessage: (message: any) => void,
    getExtraMessages: () => any[]
}

export const NotificationSchema = new mongoose.Schema<INotification>(
    {
        sender: {
            type: SchemaTypes.ObjectId,
            required: true,
            ref: "User",
            refAllowlist: SimpleUserSnippet,
            dynamicTableConfiguration: {
                dtoPath: "sender",
                refDisplayKey: ["username"],
            },
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
                others: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        receiver: {
            type: SchemaTypes.ObjectId,
            required: true,
            ref: "User",
            refAllowlist: SimpleUserSnippet,
            dynamicTableConfiguration: {
                dtoPath: "receiver",
                refDisplayKey: ["username"],
            },
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
                others: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        code: {
            type: SchemaTypes.String,
            required: true,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
                others: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        description: {
            type: SchemaTypes.String,
            default: null,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
                others: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        content: {
            type: SchemaTypes.Mixed,
            default: null,
            dynamicTableConfiguration: {
                filterable: false,
                sortable: false,
                hideColumn: true,
            },
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
                others: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        extraMessages: {
            type: [SchemaTypes.Mixed],
            default: [],
            dynamicTableConfiguration: {
                filterable: false,
                sortable: false,
                hideColumn: true,
            },
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
                others: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        } as unknown as any[],
        date: {
            type: SchemaTypes.Date,
            default: Date.now,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
                others: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        importance: {
            type: SchemaTypes.String,
            enum: Object.values(NotificationImportance),
            default: NotificationImportance.NORMAL,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
                others: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        status: {
            type: SchemaTypes.String,
            enum: Object.values(NotificationStatus),
            default: NotificationStatus.Info,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
                others: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        readOn: {
            type: SchemaTypes.Date,
            default: undefined,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
                others: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        category: {
            type: SchemaTypes.String,
            enum: Object.values(NotificationCategoryEnum),
            default: NotificationCategoryEnum.SYSTEM,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
                others: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        channels: {
            type: [SchemaTypes.String],
            enum: Object.values(NotificationDeliveryChannelEnum),
            default: function() {
                return [NotificationDeliveryChannelEnum.IN_APP, NotificationDeliveryChannelEnum.WEBSOCKET];
            },
            dynamicTableConfiguration: {
                filterable: false,
                sortable: false,
                hideColumn: true,
            },
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
                others: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        metadata: {
            type: SchemaTypes.Mixed,
            default: null,
            dynamicTableConfiguration: {
                filterable: false,
                sortable: false,
                hideColumn: true,
            },
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
                others: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        }
    },
    {
        accessMode: "loose",
        permissions: {
            self: {
                create: "no-permission"
            },
            others: {
                create: "no-permission"
            }
        }
    }
);

NotificationSchema.methods.read = function(): void {
    this.readOn = new Date();
}
NotificationSchema.methods.isRead = function(): boolean {
    return this.readOn !== undefined;
}
NotificationSchema.methods.addExtraMessage = function(message: any): void {
    this.extraMessages.push(message);
}
NotificationSchema.methods.getExtraMessages = function(): any[] {
    return this.extraMessages;
}

ownershipPlugin(NotificationSchema);
auditPlugin(NotificationSchema);
softDeletePlugin(NotificationSchema);
applyNotificationIndexes(NotificationSchema);
const Notification = mongoose.model<INotification>("Notification", NotificationSchema);
normalizeSchemaPermissions(Notification);
export default Notification;

addModelData(Notification);

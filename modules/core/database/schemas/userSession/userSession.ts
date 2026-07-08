import {Document, model, Schema, SchemaTypes} from "mongoose";
import {IUser} from "@coreModule/database/schemas/user/user";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import {IOwnershipPluginFields, ISoftDeletePluginFields} from "@coreModule/database/types/plugin-fields";
import {SimpleUserSnippet} from "@coreModule/database/schemas/user/user.snippets";
import {addModelData} from "@coreModule/database/collections";
import {applyUserSessionIndexes} from "@coreModule/database/schemas/userSession/userSession.indexes";
import {userSessionViews} from "@coreModule/database/schemas/userSession/userSession.views";

const geoItemConfig = {filterable: false, sortable: false, hideColumn: true};

export interface IUserSession extends Document, IOwnershipPluginFields, ISoftDeletePluginFields {
    user: IUser;
    sessionId: string;
    deviceId: string;
    userAgent: string;
    ipAddress: string;
    geolocation: {
        ip: string;
        hostname: string;
        city: string;
        region: string;
        country: string;
        loc: string;
        org: string;
        postal: string;
        timezone: string;
        time: number | null;
    }[];
    createdAt: Date;
    lastActiveAt: Date;
    expiresAt: Date;
    isActive: boolean;
}

const geolocationItemSchema = {
    ip: {
        type: SchemaTypes.String,
        default: "",
        dynamicTableConfiguration: geoItemConfig,
        permissions: {self: {publicRead: true}},
    },
    hostname: {
        type: SchemaTypes.String,
        default: "",
        dynamicTableConfiguration: geoItemConfig,
        permissions: {self: {publicRead: true}},
    },
    city: {
        type: SchemaTypes.String,
        default: "",
        dynamicTableConfiguration: geoItemConfig,
        permissions: {self: {publicRead: true}},
    },
    region: {
        type: SchemaTypes.String,
        default: "",
        dynamicTableConfiguration: geoItemConfig,
        permissions: {self: {publicRead: true}},
    },
    country: {
        type: SchemaTypes.String,
        default: "",
        dynamicTableConfiguration: geoItemConfig,
        permissions: {self: {publicRead: true}},
    },
    loc: {
        type: SchemaTypes.String,
        default: "",
        dynamicTableConfiguration: geoItemConfig,
        permissions: {self: {publicRead: true}},
    },
    org: {
        type: SchemaTypes.String,
        default: "",
        dynamicTableConfiguration: geoItemConfig,
        permissions: {self: {publicRead: true}},
    },
    postal: {
        type: SchemaTypes.String,
        default: "",
        dynamicTableConfiguration: geoItemConfig,
        permissions: {self: {publicRead: true}},
    },
    timezone: {
        type: SchemaTypes.String,
        default: "",
        dynamicTableConfiguration: geoItemConfig,
        permissions: {self: {publicRead: true}},
    },
    time: {
        type: SchemaTypes.Number,
        default: null,
        dynamicTableConfiguration: geoItemConfig,
        permissions: {self: {publicRead: true}},
    },
};

const UserSessionSchema = new Schema<IUserSession>(
    {
        user: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            required: true,
            refAllowlist: SimpleUserSnippet,
            dynamicTableConfiguration: {
                dtoPath: "user",
                refDisplayKey: ["name", "surname"],
            },
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
            },
        },
        sessionId: {
            type: SchemaTypes.String,
            required: true,
            unique: true,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
            },
        },
        deviceId: {
            type: SchemaTypes.String,
            required: true,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
            },
        },
        userAgent: {
            type: SchemaTypes.String,
            required: true,
            default: "",
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
            },
        },
        ipAddress: {
            type: SchemaTypes.String,
            required: true,
            default: "",
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
            },
        },
        geolocation: {
            type: [geolocationItemSchema],
            default: [],
            dynamicTableConfiguration: {
                filterable: false,
                sortable: false,
                visible: false,
            },
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
            },
        },
        createdAt: {
            type: SchemaTypes.Date,
            default: Date.now,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
            },
        },
        lastActiveAt: {
            type: SchemaTypes.Date,
            default: Date.now,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
            },
        },
        expiresAt: {
            type: SchemaTypes.Date,
            required: true,
            index: {
                expires: 0,
            },
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                },
            },
        },
        isActive: {
            type: SchemaTypes.Boolean,
            default: true,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                },
            },
        },
    },
    {
        accessMode: "strict",
    }
);

ownershipPlugin(UserSessionSchema);
auditPlugin(UserSessionSchema);
softDeletePlugin(UserSessionSchema);
applyUserSessionIndexes(UserSessionSchema);
const UserSession = model<IUserSession>("UserSession", UserSessionSchema);
normalizeSchemaPermissions(UserSession);
export default UserSession;

addModelData(UserSession, userSessionViews);

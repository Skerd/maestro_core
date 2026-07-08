import {Document, model, Schema, SchemaTypes} from "mongoose";
import {IUser} from "@coreModule/database/schemas/user/user";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import {IOwnershipPluginFields, ISoftDeletePluginFields} from "@coreModule/database/types/plugin-fields";
import {SimpleUserSnippet} from "@coreModule/database/schemas/user/user.snippets";
import {addModelData} from "@coreModule/database/collections";
import {applyLoginHistoryIndexes} from "@coreModule/database/schemas/loginHistory/loginHistory.indexes";
import {loginHistoryViews} from "@coreModule/database/schemas/loginHistory/loginHistory.views";

const geoConfig = {filterable: false, sortable: false, hideColumn: true};

export interface ILoginHistory extends Document, IOwnershipPluginFields, ISoftDeletePluginFields {
    createdAt?: Date;
    updatedAt?: Date;
    user: IUser;
    time: Date;
    status: "success" | "failure";
    mfa: boolean;
    reason?: string | null;
    device: string;
    os: string;
    browser: string;
    userAgent: string;
    ip: string;
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
    };
}

const LoginHistorySchema = new Schema<ILoginHistory>(
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
                },
            },
        },
        time: {
            type: SchemaTypes.Date,
            required: true,
            default: () => new Date(),
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                },
            },
        },
        status: {
            type: SchemaTypes.String,
            required: true,
            enum: ["success", "failure"],
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                },
            },
        },
        mfa: {
            type: SchemaTypes.Boolean,
            required: true,
            default: false,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                },
            },
        },
        reason: {
            type: SchemaTypes.String,
            required: false,
            default: null,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                },
            },
        },
        device: {
            type: SchemaTypes.String,
            required: true,
            default: "",
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                },
            },
        },
        os: {
            type: SchemaTypes.String,
            required: true,
            default: "",
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                },
            },
        },
        browser: {
            type: SchemaTypes.String,
            required: true,
            default: "",
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
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
                },
            },
        },
        ip: {
            type: SchemaTypes.String,
            required: true,
            default: "",
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                },
            },
        },
        geolocation: {
            type: {
                ip: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoConfig,
                    permissions: {
                        self: {
                            publicRead: true,
                        },
                    },
                },
                hostname: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoConfig,
                    permissions: {
                        self: {
                            publicRead: true,
                        },
                    },
                },
                city: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoConfig,
                    permissions: {
                        self: {
                            publicRead: true,
                        },
                    },
                },
                region: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoConfig,
                    permissions: {
                        self: {
                            publicRead: true,
                        },
                    },
                },
                country: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoConfig,
                    permissions: {
                        self: {
                            publicRead: true,
                        },
                    },
                },
                loc: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoConfig,
                    permissions: {
                        self: {
                            publicRead: true,
                        },
                    },
                },
                org: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoConfig,
                    permissions: {
                        self: {
                            publicRead: true,
                        },
                    },
                },
                postal: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoConfig,
                    permissions: {
                        self: {
                            publicRead: true,
                        },
                    },
                },
                timezone: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoConfig,
                    permissions: {
                        self: {
                            publicRead: true,
                        },
                    },
                },
            },
            default: {},
            dynamicTableConfiguration: {
                ...geoConfig,
                visible: false,
            },
            permissions: {
                self: {
                    publicRead: true,
                },
            },
        },
    },
    {
        accessMode: "loose",
        timestamps: true,
    }
);

ownershipPlugin(LoginHistorySchema);
auditPlugin(LoginHistorySchema);
softDeletePlugin(LoginHistorySchema);
applyLoginHistoryIndexes(LoginHistorySchema);
const LoginHistory = model<ILoginHistory>("LoginHistory", LoginHistorySchema);
normalizeSchemaPermissions(LoginHistory);
export default LoginHistory;

addModelData(LoginHistory, loginHistoryViews);

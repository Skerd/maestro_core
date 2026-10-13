import {Document, model, Schema, SchemaTypes} from "mongoose";
import {IUser} from "@coreModule/database/schemas/user/user";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import {
    ILifeCyclePluginFields,
    IOwnershipPluginFields,
    ISoftDeletePluginFields,
} from "@coreModule/database/types/plugin-fields";
import {SimpleUserSnippet} from "@coreModule/database/schemas/user/user.snippets";
import {addModelData} from "@coreModule/database/collections";
import {applyLoginHistoryIndexes} from "@coreModule/database/schemas/loginHistory/loginHistory.indexes";
import {loginHistoryViews} from "@coreModule/database/schemas/loginHistory/loginHistory.views";
import {COLUMN_TYPE} from "armonia/src/modules/core/database/filter/typeOperators";

const geoItemConfig = {filterable: true, sortable: false, visible: false};
const geoColumnConfig = {
    filterable: false,
    sortable: false,
    cellType: COLUMN_TYPE.ADDRESS,
    refDisplayKey: ["city", "country"],
};

export interface ILoginHistory extends Document, IOwnershipPluginFields, ISoftDeletePluginFields, ILifeCyclePluginFields {
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
        },
        time: {
            type: SchemaTypes.Date,
            required: true,
            default: () => new Date(),
            dynamicTableConfiguration: {},
        },
        status: {
            type: SchemaTypes.String,
            required: true,
            enum: ["success", "failure"],
            dynamicTableConfiguration: {
                enumTones: {
                    success:   "success",
                    failure:   "danger",
                },
            },
        },
        mfa: {
            type: SchemaTypes.Boolean,
            required: true,
            default: false,
        },
        reason: {
            type: SchemaTypes.String,
            required: false,
            default: null,
        },
        device: {
            type: SchemaTypes.String,
            required: true,
            default: "",
        },
        os: {
            type: SchemaTypes.String,
            required: true,
            default: "",
        },
        browser: {
            type: SchemaTypes.String,
            required: true,
            default: "",
        },
        userAgent: {
            type: SchemaTypes.String,
            required: true,
            default: "",
        },
        ip: {
            type: SchemaTypes.String,
            required: true,
            default: "",
        },
        geolocation: {
            type: {
                ip: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoItemConfig,
                },
                hostname: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoItemConfig,
                },
                city: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoItemConfig,
                },
                region: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoItemConfig,
                },
                country: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoItemConfig,
                },
                loc: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoItemConfig,
                },
                org: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoItemConfig,
                },
                postal: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoItemConfig,
                },
                timezone: {
                    type: SchemaTypes.String,
                    default: "",
                    dynamicTableConfiguration: geoItemConfig,
                },
            },
            default: {},
            dynamicTableConfiguration: geoColumnConfig,
        },
    },
    {
        accessMode: "loose",
    }
);

ownershipPlugin(LoginHistorySchema);
auditPlugin(LoginHistorySchema);
softDeletePlugin(LoginHistorySchema);
lifeCyclePlugin(LoginHistorySchema);
applyLoginHistoryIndexes(LoginHistorySchema);
const LoginHistory = model<ILoginHistory>("LoginHistory", LoginHistorySchema);
normalizeSchemaPermissions(LoginHistory);
export default LoginHistory;

addModelData(LoginHistory, loginHistoryViews);

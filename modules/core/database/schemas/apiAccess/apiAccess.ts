import mongoose, {Document, SchemaTypes} from "mongoose";
import {applyApiAccessIndexes} from "./apiAccess.indexes";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import {IUser} from "@coreModule/database/schemas/user/user";
import {ICompany} from "@coreModule/database/schemas/company/company";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import {IOwnershipPluginFields} from "@coreModule/database/types/plugin-fields";
import {SimpleBlankUserSnippet} from "@coreModule/database/schemas/user/user.snippets";

export interface IApiAccess extends Document, IOwnershipPluginFields {
    endpoint: string,
    method: string,
    statusCode: number,
    duration: number,
    errorType?: string,
    actionUser?: IUser,
    actionNumber: string,
    user?: IUser,
    company?: ICompany,
    deviceId?: string,
    userAgent?: string,
    requestIp?: string,
    source?: string,
}

export const ApiAccessSchema = new mongoose.Schema<IApiAccess>(
    {
        endpoint: {
            type: SchemaTypes.String,
            required: true,
            permissions: {
                self: {
                    write: "no-permission",
                }
            }
        },
        method: {
            type: SchemaTypes.String,
            required: true,
            permissions: {
                self: {
                    write: "no-permission",
                }
            }
        },
        statusCode: {
            type: SchemaTypes.Number,
            required: true,
            permissions: {
                self: {
                    write: "no-permission",
                }
            }
        },
        duration: {
            type: SchemaTypes.Number,
            required: true,
            permissions: {
                self: {
                    write: "no-permission",
                }
            }
        },
        errorType: {
            type: SchemaTypes.String,
            permissions: {
                self: {
                    write: "no-permission",
                }
            }
        },
        actionUser: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            permissions: {
                self: {
                    write: "no-permission",
                }
            },
            refAllowlist: SimpleBlankUserSnippet
        },
        actionNumber: {
            type: SchemaTypes.String,
            required: true,
            permissions: {
                self: {
                    write: "no-permission",
                }
            }
        },
        user: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            permissions: {
                self: {
                    write: "no-permission",
                }
            },
            refAllowlist: SimpleBlankUserSnippet
        },
        deviceId: {
            type: SchemaTypes.String,
            permissions: {
                self: {
                    write: "no-permission",
                }
            }
        },
        userAgent: {
            type: SchemaTypes.String,
            permissions: {
                self: {
                    write: "no-permission",
                }
            }
        },
        requestIp: {
            type: SchemaTypes.String,
            permissions: {
                self: {
                    write: "no-permission",
                }
            }
        },
        source: {
            type: SchemaTypes.String,
            permissions: {
                self: {
                    write: "no-permission",
                }
            }
        }
    },
    {
        accessMode: "loose",
        permissions: {
            self: {
                create: "no-permission",
                delete: "no-permission",
                restore: "no-permission",
            },
            others: {
                create: "no-permission",
                delete: "no-permission",
                restore: "no-permission",
            }
        }
    }
);

ownershipPlugin(ApiAccessSchema);
applyApiAccessIndexes(ApiAccessSchema);
// `ownershipPlugin` injects `company` as required for tenant scoping, but ApiAccess
// is an audit-grade collection that legitimately records pre-authentication hits
// (login, password reset, health probes, public endpoints) where no company is in
// scope. Relaxing the requirement after plugin application keeps tenant scoping
// optional without rewriting the plugin contract. 
ApiAccessSchema.path("company").required(false);

const ApiAccess = mongoose.model<IApiAccess>("ApiAccess", ApiAccessSchema);
normalizeSchemaPermissions(ApiAccess);
export default ApiAccess;

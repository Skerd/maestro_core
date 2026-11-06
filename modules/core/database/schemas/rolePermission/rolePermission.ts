import {Document, model, Schema, SchemaTypes} from "mongoose";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import {applyRolePermissionIndexes} from "./rolePermission.indexes";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";

export interface IRolePermission extends Document {
    name: string,
    group: string,
    tag: string,
    alwaysActive: boolean,
    /** Module owning the model the tag comes from; hidden from companies without it. */
    module: string,
    /** Set when the tag covers special-category data (SEC-06): default roles get it only where they list the group. */
    sensitivity?: "health" | "identity" | "payment"
}

const RolePermissionSchema = new Schema<IRolePermission>(
    {
        name: {
            type: SchemaTypes.String,
            required: true,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        group: {
            type: SchemaTypes.String,
            required: true,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        tag: {
            type: SchemaTypes.String,
            required: true,
            unique: true,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        alwaysActive: {
            type: SchemaTypes.Boolean,
            required: true,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        module: {
            type: SchemaTypes.String,
            default: "core",
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        },
        sensitivity: {
            type: SchemaTypes.String,
            enum: ["health", "identity", "payment"],
            required: false,
            permissions: {
                self: {
                    publicRead: true,
                    write: "no-permission"
                }
            }
        }
    },
    {
        permissions: {
            self: {
                restore: "no-permission",
                create: "no-permission",
                delete: "no-permission",
            }
        },
        accessMode: "loose"
    }
);

// No ownership, softDelete or audit (plugin-exemptions.json): RolePermission is a global catalog of permission
// tags written only by the boot sync, not a tenant document, so the audit log (company-scoped) cannot record it.
applyRolePermissionIndexes(RolePermissionSchema);
lifeCyclePlugin(RolePermissionSchema);
const RolePermission = model<IRolePermission>("RolePermission", RolePermissionSchema);
normalizeSchemaPermissions(RolePermission);
export default RolePermission;

// RolePermission.syncIndexes(); // Uncomment to manually sync indexes

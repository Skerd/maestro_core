import {Document, model, Schema, SchemaTypes} from "mongoose";
import {applyRolePermissionIndexes} from "./rolePermission.indexes";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";

export interface IRolePermission extends Document {
    name: string,
    group: string,
    tag: string,
    alwaysActive: boolean
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

// No ownershipPlugin / softDeletePlugin / lifeCyclePlugin: RolePermission is a global
// catalog of permission tags, not a tenant document. Model create/delete/restore are no-permission.
auditPlugin(RolePermissionSchema);
applyRolePermissionIndexes(RolePermissionSchema);
const RolePermission = model<IRolePermission>("RolePermission", RolePermissionSchema);
normalizeSchemaPermissions(RolePermission);
export default RolePermission;

// RolePermission.syncIndexes(); // Uncomment to manually sync indexes

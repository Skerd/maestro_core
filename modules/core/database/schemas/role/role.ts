import mongoose, {Document, Schema, SchemaTypes} from "mongoose";
import {IRolePermission} from "@coreModule/database/schemas/rolePermission/rolePermission";
import {applyRoleIndexes} from "./role.indexes";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import {IOwnershipPluginFields, ISoftDeletePluginFields} from "@coreModule/database/types/plugin-fields";
import {addModelData} from "@coreModule/database/collections";

export interface IRole extends Document, IOwnershipPluginFields, ISoftDeletePluginFields {
    name: string,
    clearanceLevel: number,
    permissions: IRolePermission[],
    company: ICompany,
    isAdmin: boolean,
    isSignupDefault: boolean,
    canEdit: boolean,
    canDelete: boolean,
    slug: string,
    getPermissions: () => Promise<string[]>,
    hasPermission: (permission: string) => Promise<boolean>,
    getClearance: () => number,
    hasClearance: (clearanceLevel: number) => boolean
}

export const RoleSchema: Schema = new Schema<IRole>(
    {
        name: {
            type: SchemaTypes.String,
            required: true,
            dynamicTableConfiguration: {}
        },
        permissions: {
            type: [SchemaTypes.ObjectId],
            ref: "RolePermission",
            required: true,
            dynamicTableConfiguration: {
                hideColumn: true,
            }
        },
        isAdmin: {
            type: SchemaTypes.Boolean,
            required: true,
            default: false,
            dynamicTableConfiguration: {
                hideColumn: true,
            },
            permissions: {
                self: {
                    read: "no-permission",
                    write: "no-permission"
                },
                others: {
                    read: "no-permission",
                    write: "no-permission",
                }
            }
        },
        isSignupDefault: {
            type: SchemaTypes.Boolean,
            required: true,
            default: false,
            dynamicTableConfiguration: {
                hideColumn: true,
            },
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
        canEdit: {
            type: SchemaTypes.Boolean,
            required: true,
            default: true,
            dynamicTableConfiguration: {
                hideColumn: true,
            },
            permissions: {
                self: {
                    read: "no-permission",
                    write: "no-permission"
                },
                others: {
                    read: "no-permission",
                    write: "no-permission",
                }
            }
        },
        canDelete: {
            type: SchemaTypes.Boolean,
            required: true,
            default: true,
            dynamicTableConfiguration: {
                hideColumn: true,
            },
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
        slug: {
            type: SchemaTypes.String,
            required: true,
            dynamicTableConfiguration: {
                hideColumn: true,
            },
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
        accessMode: "loose"
    }
);

RoleSchema.methods.getPermissions = async function (): Promise<string[]> {
    await this.populate("permissions");
    return this.permissions.map((permission) => permission.tag);
}
RoleSchema.methods.hasPermission = async function(permission: string): Promise<boolean> {
    await this.populate("permissions");
    return this.permissions.map((permission) => permission.tag).includes(permission);
}

ownershipPlugin(RoleSchema);
auditPlugin(RoleSchema);
softDeletePlugin(RoleSchema);
applyRoleIndexes(RoleSchema);
const Role = mongoose.model<IRole>("Role", RoleSchema);
normalizeSchemaPermissions(Role);
export default Role;

addModelData(Role);

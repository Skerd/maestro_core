import mongoose, {Document, Schema, SchemaTypes} from "mongoose";
import {IRolePermission} from "@coreModule/database/schemas/rolePermission/rolePermission";
import {applyRoleIndexes} from "./role.indexes";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import {
    ILifeCyclePluginFields,
    IOwnershipPluginFields,
    ISoftDeletePluginFields
} from "@coreModule/database/types/plugin-fields";
import {addModelData} from "@coreModule/database/collections";
import {invalidateRoleAccess} from "@coreModule/utilities/security/roleAccessCache";

export interface IRole extends Document, IOwnershipPluginFields, ISoftDeletePluginFields, ILifeCyclePluginFields {
    name: string,
    description?: string,
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
        description: {
            type: SchemaTypes.String,
            required: false,
            default: "",
            trim: true,
            dynamicTableConfiguration: {},
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

/**
 * Keep the Redis role-access cache honest.
 *
 * authMW resolves permission tags through `roleAccessCache`, keyed per role. Anything that
 * mutates a role — the roles API, the boot-time permission sync, a soft delete (which the
 * soft-delete plugin rewrites into an update) — has to drop that entry, so invalidation
 * lives here rather than at each call site where it could be forgotten.
 *
 * Query-based writes don't carry the affected ids, so they are resolved from the filter
 * before invalidating. Role writes are rare, so the extra lookup costs nothing in practice.
 */
RoleSchema.post("save", async function (doc: any) {
    await invalidateRoleAccess([doc._id]);
});

const ROLE_WRITE_QUERIES = [
    "findOneAndUpdate",
    "findOneAndDelete",
    "updateOne",
    "updateMany",
    "deleteOne",
    "deleteMany"
] as any;

// Ids are resolved before the write: a soft delete flips `deletedAt`, so the same filter
// would match nothing by the time the post hook runs.
RoleSchema.pre(ROLE_WRITE_QUERIES, async function (this: any) {
    try {
        const affected = await this.model
            .find(this.getFilter())
            .withDeleted()
            .select("_id")
            .lean();
        this._roleAccessInvalidationIds = affected.map((role: any) => role._id);
    } catch {
        this._roleAccessInvalidationIds = [];
    }
});

RoleSchema.post(ROLE_WRITE_QUERIES, async function (this: any) {
    try {
        await invalidateRoleAccess(this._roleAccessInvalidationIds ?? []);
    } catch {
        // Cache invalidation must never fail a write; the TTL bounds any staleness.
    }
});

ownershipPlugin(RoleSchema);
auditPlugin(RoleSchema);
softDeletePlugin(RoleSchema);
lifeCyclePlugin(RoleSchema);
applyRoleIndexes(RoleSchema);
const Role = mongoose.model<IRole>("Role", RoleSchema);
normalizeSchemaPermissions(Role);
export default Role;

addModelData(Role);

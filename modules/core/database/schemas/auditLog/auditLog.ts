import {Document, model, Schema, SchemaTypes, Types} from "mongoose";
import {applyAuditLogIndexes} from "@coreModule/database/schemas/auditLog/auditLog.indexes";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import {IOwnershipPluginFields} from "@coreModule/database/types/plugin-fields";

export type AuditAction = "CREATE" | "UPDATE" | "DELETE" | "RESTORE";

export interface AuditDiffEntry {
    from: unknown;
    to: unknown;
}

export interface IAuditLog extends Document, IOwnershipPluginFields {
    documentId: Types.ObjectId;
    collectionName: string;
    organizationId?: Types.ObjectId;
    actorId?: Types.ObjectId;
    action: AuditAction;
    diff: Record<string, AuditDiffEntry>;
    createdAt: Date;
    updatedAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
    {
        documentId: {
            type: SchemaTypes.ObjectId,
            required: true,
            permissions: {
                self: {
                    read: "no-permission",
                    write: "no-permission"
                }
            }
        },
        collectionName: {
            type: SchemaTypes.String,
            required: true,
            permissions: {
                self: {
                    read: "no-permission",
                    write: "no-permission"
                }
            }
        },
        organizationId: {
            type: SchemaTypes.ObjectId,
            ref: "Company",
            required: false,
            permissions: {
                self: {
                    read: "no-permission",
                    write: "no-permission"
                }
            }
        },
        actorId: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            required: false,
            permissions: {
                self: {
                    write: "no-permission"
                }
            }
        },
        action: {
            type: SchemaTypes.String,
            required: true,
            enum: ["CREATE", "UPDATE", "DELETE", "RESTORE"],
            permissions: {
                self: {
                    write: "no-permission"
                }
            }
        },
        diff: {
            type: SchemaTypes.Mixed,
            required: true,
            permissions: {
                self: {
                    write: "no-permission"
                }
            }
        },
        createdAt: {
            type: SchemaTypes.Date,
            permissions: {
                self: {
                    write: "no-permission",
                }
            }
        },
        updatedAt: {
            type: SchemaTypes.Date,
            permissions: {
                self: {
                    write: "no-permission",
                }
            }
        }
    },
    {
        timestamps: true,
        permissions: {
            self: {
                create: "no-permission",
                delete: "no-permission",
                restore: "no-permission"
            }
        },
        accessMode: "loose"
    }
);

ownershipPlugin(AuditLogSchema);
applyAuditLogIndexes(AuditLogSchema);
export const AuditLog = model<IAuditLog>("AuditLog", AuditLogSchema);
normalizeSchemaPermissions(AuditLog);
export default AuditLog;

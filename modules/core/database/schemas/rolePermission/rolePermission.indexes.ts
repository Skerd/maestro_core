import {Schema} from "mongoose";

export function applyRolePermissionIndexes(RolePermissionSchema: Schema): void {
    // Primary field indexes
    RolePermissionSchema.index({ name: 1 });        // For finding permissions by name
    RolePermissionSchema.index({ group: 1 });       // For finding permissions by group
    RolePermissionSchema.index({ tag: 1 });         // For finding permissions by tag (permission identifier)

    // Compound indexes for common query patterns
    RolePermissionSchema.index({ group: 1, tag: 1 });        // For finding specific permission within a group
    RolePermissionSchema.index({ group: 1, name: 1 });       // For finding permissions by group and name
}

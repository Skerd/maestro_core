import {Schema} from "mongoose";

export function applyRoleIndexes(RoleSchema: Schema): void {
    // Primary field indexes
    RoleSchema.index({name: 1});
    RoleSchema.index({company: 1});
    RoleSchema.index({slug: 1}, {unique: true});

    // Boolean flag indexes
    RoleSchema.index({isAdmin: 1});
    RoleSchema.index({isSignupDefault: 1});
    RoleSchema.index({canEdit: 1});
    RoleSchema.index({canDelete: 1});

    // Array field indexes
    RoleSchema.index({permissions: 1});

    // Compound indexes for common query patterns
    RoleSchema.index({company: 1, createdAt: -1});
    RoleSchema.index({createdAt: -1});
    RoleSchema.index({company: 1, name: 1});
    RoleSchema.index({company: 1, isAdmin: 1});
    RoleSchema.index({company: 1, isSignupDefault: 1});
    RoleSchema.index({company: 1, slug: 1});
    RoleSchema.index({company: 1, permissions: 1});
    RoleSchema.index({isAdmin: 1, isSignupDefault: 1});
    RoleSchema.index({company: 1, isAdmin: 1, isSignupDefault: 1});
    RoleSchema.index({permissions: 1, company: 1});
}

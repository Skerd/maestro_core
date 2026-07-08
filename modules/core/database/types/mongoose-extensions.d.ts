import "mongoose";
import {COLUMN_TYPE} from "armonia/src/modules/core/database/filter/typeOperators";

declare module "mongoose" {

    export type PermissionAction = "read" | "write";
    export type ModelPermissionAction = "create" | "delete" | "restore";
    export type AccessMode = "strict" | "loose";

    export interface PermissionRule {
        read?: string;
        write?: string;
        publicRead?: boolean;
        publicWrite?: boolean;
    }
    export interface ModelPermissionRule {
        create?: string;
        delete?: string;
        restore?: string;
        publicCreate?: boolean;
        publicDelete?: boolean;
    }

    export interface FieldPermissions {
        self?: PermissionRule;
        others?: PermissionRule;
    }
    export interface ModelPermissions {
        self?: ModelPermissionRule;
        others?: ModelPermissionRule;
    }

    export interface SchemaOptions {
        // if no permissions are provided, the default permission behavior is applied
        permissions?: ModelPermissions;
        // if access mode is strict, self and others permissions are applied, otherwise just self
        accessMode?: AccessMode;
    }


    /**
     * For ref paths: which nested keys to expose when populated.
     * Used by schemaToFieldAllowlist; schema is source of truth.
     */
    export interface RefAllowlist {
        keys?: Record<string, RefAllowlist | Record<string, never>>;
    }

    export interface SchemaTypeOptions<T> {
        /**
         * Fine-grained permissions for the field, differentiated between document owner (self)
         * and other users in the same organization/tenant.
         */
        permissions?: FieldPermissions;
        /**
         * For ref fields: which populated keys to allow. Used by schemaToFieldAllowlist.
         */
        refAllowlist?: RefAllowlist;

        dynamicTableConfiguration?: {
            /**
             * When false, the field is excluded from dynamic filter field generation.
             * Default is true (filterable).
             */
            filterable?: boolean;
            /**
             * This value determines if the column in dynamic table configuration generation is visible. user can override this
             */
            visible?: boolean;
            /**
             * This value determines if the column in dynamic table configuration generation is sortable. user can override this
             */
            sortable?: boolean;
            /**
             * This value determines the column type in dynamic table configuration generation. user can override this
             */
            cellType?: COLUMN_TYPE;

            dtoPath?: string;

            /**
             * For ref/ObjectId columns: ordered field paths from the populated document used to build the display label.
             * Passed to client as-is (fully serializable). Client joins values with space.
             * E.g. ["name", "surname"] → "John Doe".
             * Fallback when unset: single "name" field for backward compatibility.
             */
            refDisplayKey?: string[];

            /**
             * When true, the field is excluded from filters and from table config columns.
             */
            hideColumn?: boolean;
        }

    }

    export interface SchemaType<T = any> {
        options: SchemaTypeOptions<T> & {
            permissions?: FieldPermissions;
        };
    }
}


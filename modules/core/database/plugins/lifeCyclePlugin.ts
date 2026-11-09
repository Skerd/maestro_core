import {Schema, SchemaDefinition, SchemaTypes} from "mongoose";
import {COLUMN_TYPE} from "armonia/src/modules/core/database/filter/typeOperators";

/** The plugin's definition of a timestamp field: server-owned, filterable and sortable in tables. */
function timestampField() {
    return {
        type: SchemaTypes.Date,
        dynamicTableConfiguration: {
            filterable: true,
            sortable: true,
            cellType: COLUMN_TYPE.DATETIME,
            visible: false,
        },
        permissions: {
            self: {
                write: "no-permission"
            },
            others: {
                write: "no-permission"
            }
        }
    };
}

/**
 * A schema that declares the field itself, with its own permissions (a public read, a default, required), keeps
 * its definition; Mongoose's `timestamps` paths declare none and get the plugin's.
 */
function declaredBySchema(schema: Schema, path: "createdAt" | "updatedAt"): boolean {
    return (schema.path(path)?.options as {permissions?: unknown} | undefined)?.permissions !== undefined;
}

/**
 * `createdAt` / `updatedAt` on every schema (DB-01; lifeCycle has no exemption): the field definitions (server-owned,
 * table-filterable), stamped on save and on `findOneAndUpdate` / `updateOne` / `updateMany`. On a schema that also has
 * Mongoose `timestamps` (auditPlugin sets them) these hooks run after Mongoose's and decide the stored values: a create
 * always gets `now` as `createdAt`, and every save bumps `updatedAt`, even with nothing modified.
 *
 * It also adds the `{company: 1, _id: 1}` index for tenant-scoped queries, only on a schema with a `company` path. It lives
 * here rather than in ownershipPlugin because every schema applies this plugin, so a schema that declares `company`
 * itself gets it too. The path is looked up when the model is compiled (Mongoose emits the schema's `init` then, before
 * any index is built), so the result is the same whether ownershipPlugin, which adds `company`, runs before or after.
 */
export const lifeCyclePlugin = (schema: Schema): void => {
    const fields: SchemaDefinition = {};
    for (const path of ["createdAt", "updatedAt"] as const) {
        if (!declaredBySchema(schema, path)) fields[path] = timestampField();
    }
    schema.add(fields);

    schema.pre("save", function (next) {
        const now = new Date();
        if (this.isNew) this.set("createdAt", now);
        this.set("updatedAt", now);
        next();
    });

    schema.pre(["findOneAndUpdate", "updateOne", "updateMany"], function (next) {
        this.set({updatedAt: new Date()});
        next();
    });

    schema.once("init", () => {
        if (schema.path("company")) schema.index({company: 1, _id: 1});
    });
};

export default lifeCyclePlugin;

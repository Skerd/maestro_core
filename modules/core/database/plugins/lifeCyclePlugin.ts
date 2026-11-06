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

    // Compound index to keep tenant-scoped queries efficient
    schema.index({company: 1, _id: 1});
};

export default lifeCyclePlugin;

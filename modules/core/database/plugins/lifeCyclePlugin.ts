import {Schema, SchemaTypes} from "mongoose";

export const lifeCyclePlugin = (schema: Schema): void => {
    schema.add({
        createdAt: {
            type: SchemaTypes.Date,
        },
        updatedAt: {
            type: SchemaTypes.Date,
        },
    });

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

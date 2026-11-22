import {Schema} from "mongoose";

export function applyUploadRefusalIndexes(schema: Schema): void {
    // The platform's review lists every company's refusals, newest first.
    schema.index({createdAt: -1});
    schema.index({company: 1, createdAt: -1});
}

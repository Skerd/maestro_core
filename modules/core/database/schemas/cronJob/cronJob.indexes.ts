import {Schema} from "mongoose";

export function applyCronJobIndexes(schema: Schema): void {
    schema.index({active: 1, pausedAt: 1, nextRunAt: 1, priority: -1});
    schema.index({handler: 1});
    schema.index({tags: 1});
    schema.index(
        {company: 1, code: 1},
        {unique: true, partialFilterExpression: {company: {$type: "objectId"}, deletedAt: null}},
    );
    schema.index(
        {code: 1},
        {unique: true, partialFilterExpression: {company: null, deletedAt: null}},
    );
}

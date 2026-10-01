import {Schema} from "mongoose";

export function applyBlogPostIndexes(schema: Schema): void {
    schema.index(
        {company: 1, slug: 1},
        {unique: true, partialFilterExpression: {deletedAt: null}},
    );
    schema.index({company: 1, deletedAt: 1, published: 1, publishedAt: -1});
}

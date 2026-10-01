import type {IBlogPost} from "@coreModule/database/schemas/blogPost/blogPost";

export function blogPostsToSelect(docs: IBlogPost[]) {
    return docs.map((doc) => ({
        value: doc._id.toString(),
        label: doc.title,
    }));
}

import type {BlogCategorySimple} from "armonia/src/modules/core/dto/blogCategory.dto";
import type {IBlogCategory} from "@coreModule/database/schemas/blogCategory/blogCategory";
import {defineSnippet} from "@coreModule/database/utilities/snippet";

export const BlogCategorySimpleSnippet = defineSnippet<IBlogCategory, BlogCategorySimple>()({
    keys: {
        _id: {},
        name: {},
        slug: {},
    },
});

import type {ApiSelectDatum} from "armonia/src/modules/core/types/shared.types";
import type {IBlogCategory} from "@coreModule/database/schemas/blogCategory/blogCategory";

export function blogCategoryToSelect(category: IBlogCategory): ApiSelectDatum {
    return {
        value: category._id.toString(),
        label: category.name,
    };
}

export function blogCategoriesToSelect(categories: IBlogCategory[]): ApiSelectDatum[] {
    return categories.map(blogCategoryToSelect);
}

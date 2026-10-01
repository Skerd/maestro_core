import type {IBlogCategory} from "@coreModule/database/schemas/blogCategory/blogCategory";
import type {BlogCategory} from "armonia/src/modules/core/api/auxiliary/private/blogCategory/blogCategory.dto";
import {
    mapLifeCycleToDTO,
    mapOwnershipToDTO,
    mapSoftDeleteToDTO,
} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

export function blogCategoryToDTO(category: IBlogCategory): BlogCategory {
    return {
        _id: category._id.toString(),
        name: category.name,
        slug: category.slug,
        description: category.description,
        ...mapSoftDeleteToDTO(category),
        ...mapOwnershipToDTO(category),
        ...mapLifeCycleToDTO(category),
    };
}

export function blogCategoriesToDTO(categories: IBlogCategory[]): BlogCategory[] {
    return categories.map(blogCategoryToDTO);
}

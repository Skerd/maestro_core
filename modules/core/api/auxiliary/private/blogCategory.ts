import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import {blogCategoryService} from "@coreModule/database/schemas/blogCategory/blogCategory.service";
import BlogCategory, {type IBlogCategory} from "@coreModule/database/schemas/blogCategory/blogCategory";
import {blogCategoriesToDTO, blogCategoryToDTO} from "@coreModule/utilities/mappers/blogCategory/blogCategoryMapper.dto";
import {blogCategoriesToSelect} from "@coreModule/utilities/mappers/blogCategory/blogCategoryMapper.select";
import {buildCreateDataFromSchemaDef, buildUpdateDataFromSchemaDef} from "@coreModule/api/buildUpdateDataFromSchemaDef";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {createBlogCategoryFormSchema} from "armonia/src/modules/core/api/auxiliary/private/blogCategory/createBlogCategory.form.validator";
import {editBlogCategoryFormSchema} from "armonia/src/modules/core/api/auxiliary/private/blogCategory/editBlogCategory.form.validator";
import {BlogCategorySchemaDef} from "armonia/src/modules/core/api/auxiliary/private/blogCategory/blogCategory.schema-def";
import type {CreateBlogCategoryFormType, EditBlogCategoryFormType} from "armonia/src/modules/core/api/auxiliary/private/blogCategory/blogCategory.schema-def";

export const basePath = "/api/auxiliary/blogCategory";

export const {router} = createCrudRouter<IBlogCategory, CreateBlogCategoryFormType, EditBlogCategoryFormType>({
    collectionName: "blogcategories",
    model:          BlogCategory,
    service:        blogCategoryService,
    entityName:     "BlogCategory",
    createSchema:   createBlogCategoryFormSchema,
    editSchema:     editBlogCategoryFormSchema,
    toDTO:          blogCategoryToDTO,
    toDTOArray:     blogCategoriesToDTO,
    toSelect:       blogCategoriesToSelect,
    selectSearchField: "name",
    selectSort:     {name: 1},
    defaultSort:    {name: 1},
    buildCreateData: async (params) => {
        const data = buildCreateDataFromSchemaDef(BlogCategorySchemaDef)(params);
        const taken = await blogCategoryService.findOne(
            {company: params.company._id, slug: data.slug},
            {session: params.session, logger: params.logger, languageCode: params.languageCode},
        );
        if (taken) {
            throw apiValidationException("blog_category_slug_taken", "", null, params.languageCode);
        }
        return data;
    },
    buildUpdateData: async (params, writeFields) => {
        const data = buildUpdateDataFromSchemaDef(BlogCategorySchemaDef)(params, writeFields);
        if (data.slug !== undefined) {
            const taken = await blogCategoryService.findOne(
                {company: params.company._id, slug: data.slug, _id: {$ne: params.existing._id}},
                {session: params.session, logger: params.logger, languageCode: params.languageCode},
            );
            if (taken) {
                throw apiValidationException("blog_category_slug_taken", "", null, params.languageCode);
            }
        }
        return data;
    },
});

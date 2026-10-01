import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import {mediaUploadMW} from "@coreModule/utilities/middlewares/mediaUploadMW";
import {buildCreateDataFromSchemaDef, buildUpdateDataFromSchemaDef} from "@coreModule/api/buildUpdateDataFromSchemaDef";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {BlogPostSchemaDef} from "armonia/src/modules/core/api/auxiliary/private/blogPost/blogPost.schema-def";
import {createBlogPostFormSchema} from "armonia/src/modules/core/api/auxiliary/private/blogPost/createBlogPost.form.validator";
import {editBlogPostFormSchema} from "armonia/src/modules/core/api/auxiliary/private/blogPost/editBlogPost.form.validator";
import type {CreateBlogPostFormType, EditBlogPostFormType} from "armonia/src/modules/core/api/auxiliary/private/blogPost/blogPost.schema-def";
import BlogPost, {type IBlogPost} from "@coreModule/database/schemas/blogPost/blogPost";
import {blogPostService} from "@coreModule/database/schemas/blogPost/blogPost.service";
import {BlogPostActions} from "@coreModule/database/schemas/blogPost/blogPost.actions";
import {blogPostToDTO, blogPostsToDTO} from "@coreModule/utilities/mappers/blogPost/blogPostMapper.dto";
import {blogPostsToSelect} from "@coreModule/utilities/mappers/blogPost/blogPostMapper.select";

const mediaUpload = mediaUploadMW({
    fields: {mainImage: 1, imageGallery: 20},
    maxFileSize: 250 * 1024 * 1024,
});

export const basePath = "/api/auxiliary/blogPost";

export const {router} = createCrudRouter<IBlogPost, CreateBlogPostFormType, EditBlogPostFormType>({
    collectionName: "blogposts",
    model:          BlogPost,
    service:        blogPostService,
    entityName:     "BlogPost",
    createSchema:   createBlogPostFormSchema,
    editSchema:     editBlogPostFormSchema,
    toDTO:          blogPostToDTO,
    toDTOArray:     blogPostsToDTO,
    toSelect:       blogPostsToSelect,
    defaultSort:    {publishedAt: -1, createdAt: -1},
    selectSort:     {title: 1},
    selectSearchField: "title",
    actions:        BlogPostActions,
    createMiddleware: [mediaUpload],
    editMiddleware:   [mediaUpload],
    buildCreateData: async (params) => {
        const data = buildCreateDataFromSchemaDef(BlogPostSchemaDef)(params);
        data.published = false;
        const taken = await blogPostService.findOne(
            {company: params.company._id, slug: data.slug},
            {session: params.session, logger: params.logger, languageCode: params.languageCode},
        );
        if (taken) {
            throw apiValidationException("blog_post_slug_taken", "", null, params.languageCode);
        }
        return data;
    },
    buildUpdateData: async (params, writeFields) => {
        const data = buildUpdateDataFromSchemaDef(BlogPostSchemaDef)(params, writeFields);
        if (data.slug !== undefined) {
            const taken = await blogPostService.findOne(
                {company: params.company._id, slug: data.slug, _id: {$ne: params.existing._id}},
                {session: params.session, logger: params.logger, languageCode: params.languageCode},
            );
            if (taken) {
                throw apiValidationException("blog_post_slug_taken", "", null, params.languageCode);
            }
        }
        return data;
    },
});

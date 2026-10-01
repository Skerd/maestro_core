import {Document, model, Schema, SchemaTypes} from "mongoose";
import type {IBlogCategory} from "../blogCategory/blogCategory";
import {IMedia} from "@coreModule/database/schemas/media/media";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import publicMediaPlugin from "@coreModule/database/plugins/publicMediaPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import {
    ILifeCyclePluginFields,
    IOwnershipPluginFields,
    ISoftDeletePluginFields,
} from "@coreModule/database/types/plugin-fields";
import {addModelData} from "@coreModule/database/collections";
import {COLUMN_TYPE} from "armonia/src/modules/core/database/filter/typeOperators";
import {validateSchemaDefAgainstMongoose} from "@coreModule/database/utilities/validateSchemaDefAgainstMongoose";
import {
    BlogPostSchemaDef,
    BLOG_CONTENT_MAX,
    BLOG_POST_EXCERPT_MAX,
    BLOG_POST_SLUG_MAX,
    BLOG_POST_TITLE_MAX,
} from "armonia/src/modules/core/api/auxiliary/private/blogPost/blogPost.schema-def";
import {BlogCategorySimpleSnippet} from "../blogCategory/blogCategory.snippets";
import {MediaSimpleSnippet} from "@coreModule/database/schemas/media/media.snippets";
import {applyBlogPostIndexes} from "./blogPost.indexes";
import {blogPostViews} from "./blogPost.views";

export interface IBlogPost extends Document, IOwnershipPluginFields, ISoftDeletePluginFields, ILifeCyclePluginFields {
    category: IBlogCategory;
    title: string;
    slug: string;
    excerpt?: string;
    content: string;
    mainImage?: IMedia;
    imageGallery: IMedia[];
    published: boolean;
    publishedAt?: Date;
}

const BlogPostSchema = new Schema<IBlogPost>(
    {
        category: {
            type: SchemaTypes.ObjectId,
            ref: "BlogCategory",
            required: true,
            refAllowlist: BlogCategorySimpleSnippet,
            dynamicTableConfiguration: {
                filterable: true,
                sortable: true,
                cellType: COLUMN_TYPE.OBJECT_ID,
                refDisplayKey: ["name"],
            },
        },
        title: {
            type: SchemaTypes.String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: BLOG_POST_TITLE_MAX,
            dynamicTableConfiguration: {
                filterable: true,
                sortable: true,
                cellType: COLUMN_TYPE.STRING,
            },
        },
        slug: {
            type: SchemaTypes.String,
            required: true,
            lowercase: true,
            trim: true,
            minlength: 1,
            maxlength: BLOG_POST_SLUG_MAX,
            dynamicTableConfiguration: {
                filterable: true,
                sortable: true,
                cellType: COLUMN_TYPE.STRING,
            },
        },
        excerpt: {
            type: SchemaTypes.String,
            required: false,
            trim: true,
            maxlength: BLOG_POST_EXCERPT_MAX,
            dynamicTableConfiguration: {
                sortable: false,
            },
        },
        content: {
            type: SchemaTypes.String,
            required: true,
            minlength: 1,
            maxlength: BLOG_CONTENT_MAX,
            dynamicTableConfiguration: {
                sortable: false,
            },
        },
        mainImage: {
            type: SchemaTypes.ObjectId,
            ref: "Media",
            required: false,
            refAllowlist: MediaSimpleSnippet,
            dynamicTableConfiguration: {
                sortable: false,
                cellType: COLUMN_TYPE.AVATAR,
            },
        },
        imageGallery: {
            type: [{type: SchemaTypes.ObjectId, ref: "Media"}],
            default: [],
            refAllowlist: MediaSimpleSnippet,
            dynamicTableConfiguration: {
                sortable: false,
            },
        },
        published: {
            type: SchemaTypes.Boolean,
            required: false,
            default: false,
            dynamicTableConfiguration: {
                filterable: true,
                sortable: true,
                cellType: COLUMN_TYPE.BOOLEAN,
            },
        },
        publishedAt: {
            type: SchemaTypes.Date,
            required: false,
            permissions: {
                self: {write: "no-permission"},
                others: {write: "no-permission"},
            },
            dynamicTableConfiguration: {
                filterable: true,
                sortable: true,
                cellType: COLUMN_TYPE.DATE,
            },
        },
    },
    {accessMode: "loose"},
);

BlogPostSchema.pre("validate", function (next) {
    if (this.published && !this.publishedAt) {
        this.publishedAt = new Date();
    }
    next();
});

ownershipPlugin(BlogPostSchema);
publicMediaPlugin(BlogPostSchema, {schemaDef: BlogPostSchemaDef});
auditPlugin(BlogPostSchema);
softDeletePlugin(BlogPostSchema);
lifeCyclePlugin(BlogPostSchema);
applyBlogPostIndexes(BlogPostSchema);

const BlogPost = model<IBlogPost>("BlogPost", BlogPostSchema);
normalizeSchemaPermissions(BlogPost);
export default BlogPost;

addModelData(BlogPost, blogPostViews);
validateSchemaDefAgainstMongoose(BlogPostSchema, BlogPostSchemaDef, "BlogPost");

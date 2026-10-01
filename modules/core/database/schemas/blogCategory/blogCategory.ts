import {Document, model, Schema, SchemaTypes} from "mongoose";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
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
    BlogCategorySchemaDef,
    BLOG_CATEGORY_DESCRIPTION_MAX,
    BLOG_CATEGORY_NAME_MAX,
    BLOG_CATEGORY_SLUG_MAX,
} from "armonia/src/modules/core/api/auxiliary/private/blogCategory/blogCategory.schema-def";
import {applyBlogCategoryIndexes} from "./blogCategory.indexes";
import {blogCategoryViews} from "./blogCategory.views";

export interface IBlogCategory extends Document, IOwnershipPluginFields, ISoftDeletePluginFields, ILifeCyclePluginFields {
    name: string;
    slug: string;
    description?: string;
}

const BlogCategorySchema = new Schema<IBlogCategory>(
    {
        name: {
            type: SchemaTypes.String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: BLOG_CATEGORY_NAME_MAX,
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
            maxlength: BLOG_CATEGORY_SLUG_MAX,
            dynamicTableConfiguration: {
                filterable: true,
                sortable: true,
                cellType: COLUMN_TYPE.STRING,
            },
        },
        description: {
            type: SchemaTypes.String,
            required: false,
            trim: true,
            maxlength: BLOG_CATEGORY_DESCRIPTION_MAX,
            dynamicTableConfiguration: {
                sortable: false,
            },
        },
    },
    {accessMode: "loose"},
);

ownershipPlugin(BlogCategorySchema);
auditPlugin(BlogCategorySchema);
softDeletePlugin(BlogCategorySchema);
lifeCyclePlugin(BlogCategorySchema);
applyBlogCategoryIndexes(BlogCategorySchema);

const BlogCategory = model<IBlogCategory>("BlogCategory", BlogCategorySchema);
normalizeSchemaPermissions(BlogCategory);
export default BlogCategory;

addModelData(BlogCategory, blogCategoryViews);
validateSchemaDefAgainstMongoose(BlogCategorySchema, BlogCategorySchemaDef, "BlogCategory");

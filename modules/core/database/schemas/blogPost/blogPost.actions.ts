import {ObjectId} from "mongodb";
import {action} from "@coreModule/api/actionDecorator";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import {getModelCollectedData} from "@coreModule/database/collections";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";
import type {BlogPost as BlogPostDTO} from "armonia/src/modules/core/api/auxiliary/private/blogPost/blogPost.dto";
import BlogPost from "@coreModule/database/schemas/blogPost/blogPost";
import {blogPostService} from "@coreModule/database/schemas/blogPost/blogPost.service";
import {blogPostToDTO} from "@coreModule/utilities/mappers/blogPost/blogPostMapper.dto";

export class BlogPostActions {
    @action({
        auth: "private",
        rateLimit: {windowMs: 60000, max: 30},
        schema: validateSingleForm,
        transaction: true,
    })
    async publish(params: Record<string, any>): Promise<BlogPostDTO> {
        return setPublishedState(params, true);
    }

    @action({
        auth: "private",
        rateLimit: {windowMs: 60000, max: 30},
        schema: validateSingleForm,
        transaction: true,
    })
    async unpublish(params: Record<string, any>): Promise<BlogPostDTO> {
        return setPublishedState(params, false);
    }
}

async function setPublishedState(params: Record<string, any>, published: boolean): Promise<BlogPostDTO> {
    const {logger, languageCode, session, company, actionUserCtx, _id} = params;

    const collected = getModelCollectedData("blogposts");
    const writeFields = SchemaGuard.sanitizeFields(
        BlogPost,
        collected.writeFields!,
        "write",
        actionUserCtx,
        languageCode,
    );
    if (!writeFields.published) {
        throw apiValidationException("user_permissions_not_sufficient", null, null, languageCode);
    }

    const existing = await blogPostService.findOneOrThrow(
        {_id: new ObjectId(_id), company: company._id},
        {session, logger, languageCode},
    );

    if (existing.published !== published) {
        const update: {published: boolean; publishedAt?: Date} = {published};
        if (published && !existing.publishedAt) {
            update.publishedAt = new Date();
        }
        await blogPostService.updateByIdOrThrow(
            existing._id,
            update,
            {session, logger, languageCode, auditUserId: actionUserCtx.userId},
        );
    }

    const readFields = SchemaGuard.sanitizeFields(
        BlogPost,
        collected.readFields!,
        "read",
        actionUserCtx,
        languageCode,
    );
    const populate = SchemaGuard.generatePopulate(readFields, BlogPost.schema);
    const populated = await blogPostService.findOneOrThrow(
        {_id: existing._id, company: company._id},
        {session, logger, languageCode},
        populate.populate,
        populate.select,
    );
    return blogPostToDTO(populated);
}

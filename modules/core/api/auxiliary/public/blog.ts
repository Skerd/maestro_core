import {Router} from "express";
import authMW, {NotAuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {dateToISOString, mapMedia, mapSnippet, objectIdToString} from "@coreModule/utilities/mappers/common.mapper";
import {resolveCompanyByOrigin} from "@coreModule/utilities/marketing/resolveCompanyByOrigin";
import {blogPostService} from "@coreModule/database/schemas/blogPost/blogPost.service";
import {blogCategoryService} from "@coreModule/database/schemas/blogCategory/blogCategory.service";
import {BlogCategorySimpleSnippet} from "@coreModule/database/schemas/blogCategory/blogCategory.snippets";
import {SimpleBlankUserSnippet} from "@coreModule/database/schemas/user/user.snippets";
import {publicBlogFormSchema} from "armonia/src/modules/core/api/auxiliary/public/blog/blog.form.validator";
import {publicBlogSingleFormSchema} from "armonia/src/modules/core/api/auxiliary/public/blog/blogSingle.form.validator";
import type {
    PublicBlogCategoryItem,
    PublicBlogFormResponseType,
    PublicBlogPostItem,
} from "armonia/src/modules/core/api/auxiliary/public/blog/blog.form.response.type";
import type {PublicBlogSingleFormResponseType} from "armonia/src/modules/core/api/auxiliary/public/blog/blogSingle.form.response.type";
import type {BlogCategorySimple} from "armonia/src/modules/core/dto/blogCategory.dto";
import type {SimpleBlankUser} from "armonia/src/modules/core/dto/user.dto";
import type {IBlogPost} from "@coreModule/database/schemas/blogPost/blogPost";
import type {IBlogCategory} from "@coreModule/database/schemas/blogCategory/blogCategory";

const DEFAULT_LIMIT = 24;
const MEDIA_BASE = "/api/auxiliary/public/media/";

const router = Router();

type PublicBlogParams = NotAuthenticatedMWType & {
    categorySlug?: string;
    limit?: number;
    page?: number;
};

type PublicBlogSingleParams = NotAuthenticatedMWType & {
    slug: string;
};

function truncateExcerpt(content: string, max = 180): string {
    const cleaned = content.replace(/\s+/g, " ").trim();
    if (cleaned.length <= max) return cleaned;
    return `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

function publicMediaUrl(media: unknown): string | undefined {
    const mapped = media ? mapMedia(media) : undefined;
    return mapped?._id ? `${MEDIA_BASE}${mapped._id}` : undefined;
}

function publicMediaUrls(mediaList: unknown): string[] {
    if (!Array.isArray(mediaList)) return [];
    return mediaList
        .map((item) => publicMediaUrl(item))
        .filter((url): url is string => Boolean(url));
}

function mapPublicCategory(doc: IBlogCategory): PublicBlogCategoryItem {
    const snippet = mapSnippet<BlogCategorySimple>()(doc, BlogCategorySimpleSnippet);
    return {
        _id: snippet?._id ?? objectIdToString(doc._id),
        name: snippet?.name ?? doc.name,
        slug: snippet?.slug ?? doc.slug,
    };
}

function mapPublicPost(post: IBlogPost): PublicBlogPostItem {
    const excerpt = post.excerpt?.trim()
        ? post.excerpt.trim()
        : truncateExcerpt(String(post.content ?? ""));
    const category = post.category
        ? mapSnippet<BlogCategorySimple>()(post.category, BlogCategorySimpleSnippet)
        : undefined;
    const author = mapSnippet<SimpleBlankUser>()(post.createdBy, SimpleBlankUserSnippet);
    const authorName = author
        ? [author.name, author.surname].filter(Boolean).join(" ").trim()
        : undefined;

    return {
        _id: objectIdToString(post._id),
        title: post.title,
        slug: post.slug,
        content: post.content,
        excerpt,
        mainImage: publicMediaUrl(post.mainImage),
        imageGallery: publicMediaUrls(post.imageGallery),
        publishedAt: dateToISOString(post.publishedAt) || undefined,
        category: category
            ? {_id: category._id, name: category.name, slug: category.slug}
            : undefined,
        authorName: authorName || undefined,
    };
}

router.post(
    "",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 120}),
    validateFormZod(publicBlogFormSchema),
    asyncHandler(listPublicBlog),
);

router.post(
    "/single",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 120}),
    validateFormZod(publicBlogSingleFormSchema),
    asyncHandler(publicBlogSingle),
);

async function listPublicBlog(params: PublicBlogParams): Promise<PublicBlogFormResponseType> {
    const {origin, languageCode, logger, categorySlug, limit, page = 1} = params;
    logger.start("Loading public blog posts...");

    const company = await resolveCompanyByOrigin(origin, languageCode);
    const categories = await blogCategoryService.find(
        {company: company._id},
        {logger, languageCode},
        undefined,
        undefined,
        {name: 1},
        100,
    );

    const postFilter: Record<string, unknown> = {
        company: company._id,
        published: true,
    };

    if (categorySlug) {
        const category = categories.find((item) => item.slug === categorySlug);
        if (!category) {
            logger.finish("Public blog category slug unmatched");
            return {
                posts: [],
                total: 0,
                categories: categories.map(mapPublicCategory),
            };
        }
        postFilter.category = category._id;
    }

    const pageSize = Math.min(limit ?? DEFAULT_LIMIT, 50);
    const [posts, total] = await Promise.all([
        blogPostService.find(
            postFilter,
            {logger, languageCode},
            ["mainImage", "imageGallery", "category", "createdBy"],
            undefined,
            {publishedAt: -1, createdAt: -1},
            pageSize,
            (page - 1) * pageSize,
        ),
        blogPostService.count(postFilter, {logger, languageCode}),
    ]);

    const mapped = posts.map(mapPublicPost);
    logger.finish(`Loaded ${mapped.length} public blog posts`);
    return {
        posts: mapped,
        total,
        categories: categories.map(mapPublicCategory),
    };
}

async function publicBlogSingle(params: PublicBlogSingleParams): Promise<PublicBlogSingleFormResponseType> {
    const {origin, languageCode, logger, slug} = params;
    logger.start(`Loading public blog post [${slug}]...`);

    const company = await resolveCompanyByOrigin(origin, languageCode);
    const post = await blogPostService.findOne(
        {
            slug,
            company: company._id,
            published: true,
        },
        {logger, languageCode},
        ["mainImage", "imageGallery", "category", "createdBy"],
    );

    if (!post) {
        throw apiValidationException("blog_post_not_found", "slug", [slug], languageCode);
    }

    logger.finish(`Loaded public blog post ${slug}`);
    return {post: mapPublicPost(post)};
}

export {router};
export const basePath = "/api/auxiliary/public/blog";

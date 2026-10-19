import {Router} from "express";
import authMW, {NotAuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {dateToISOString, mapMedia, mapSnippet, objectIdToString} from "@coreModule/utilities/mappers/common.mapper";
import {resolveCompanyByOrigin} from "@coreModule/utilities/marketing/resolveCompanyByOrigin";
import {isPlatformShopOrigin} from "@coreModule/utilities/marketing/platformShopOrigin";
import Company from "@coreModule/database/schemas/company/company";
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
    PublicBlogSeller,
} from "armonia/src/modules/core/api/auxiliary/public/blog/blog.form.response.type";
import type {PublicBlogSingleFormResponseType} from "armonia/src/modules/core/api/auxiliary/public/blog/blogSingle.form.response.type";
import type {BlogCategorySimple} from "armonia/src/modules/core/dto/blogCategory.dto";
import type {SimpleBlankUser} from "armonia/src/modules/core/dto/user.dto";
import type {IBlogPost} from "@coreModule/database/schemas/blogPost/blogPost";
import type {IBlogCategory} from "@coreModule/database/schemas/blogCategory/blogCategory";

const DEFAULT_LIMIT = 24;
const MEDIA_BASE = "/api/auxiliary/public/media/";
const POST_POPULATE = [
    "mainImage",
    "imageGallery",
    "category",
    "createdBy",
    {path: "company", select: "name logo shopSlug shopHost"},
] as const;

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

function mapPublicSeller(company: unknown): PublicBlogSeller | undefined {
    if (!company || typeof company !== "object" || !("_id" in company)) return undefined;
    const row = company as {
        _id: unknown;
        name?: unknown;
        logo?: unknown;
        shopSlug?: unknown;
        shopHost?: unknown;
    };
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name) return undefined;
    const seller: PublicBlogSeller = {_id: objectIdToString(row._id as {toString(): string}), name};
    const logo = mapMedia(row.logo);
    if (logo?._id) seller.logo = logo._id;
    if (typeof row.shopSlug === "string" && row.shopSlug.trim()) seller.shopSlug = row.shopSlug.trim();
    if (typeof row.shopHost === "string" && row.shopHost.trim()) seller.shopHost = row.shopHost.trim();
    return seller;
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
    const seller = mapPublicSeller(post.company);

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
        ...(seller ? {seller} : {}),
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

/** Collapse same slug across sellers so platform chips stay unique. */
function dedupeCategoriesBySlug(categories: IBlogCategory[]): IBlogCategory[] {
    const seen = new Set<string>();
    const unique: IBlogCategory[] = [];
    for (const category of categories) {
        const slug = category.slug ?? "";
        if (seen.has(slug)) continue;
        seen.add(slug);
        unique.push(category);
    }
    return unique;
}

async function listPublicBlog(params: PublicBlogParams): Promise<PublicBlogFormResponseType> {
    const {origin, languageCode, logger, categorySlug, limit, page = 1} = params;
    logger.start("Loading public blog posts...");

    const platform = isPlatformShopOrigin(origin);
    const company = platform ? null : await resolveCompanyByOrigin(origin, languageCode);
    const companyFilter: Record<string, unknown> = company
        ? {company: company._id}
        : {
              company: {
                  $in: (await Company.find({isActive: true}, {_id: 1}).noDeleted().lean()).map((row) => row._id),
              },
          };
    const categories = await blogCategoryService.find(
        companyFilter,
        {logger, languageCode},
        undefined,
        undefined,
        {name: 1},
        platform ? 500 : 100,
    );

    const postFilter: Record<string, unknown> = {published: true, ...companyFilter};

    if (categorySlug) {
        const matched = categories.filter((item) => item.slug === categorySlug);
        if (matched.length === 0) {
            logger.finish("Public blog category slug unmatched");
            return {
                posts: [],
                total: 0,
                categories: dedupeCategoriesBySlug(categories).map(mapPublicCategory),
            };
        }
        postFilter.category = matched.length === 1
            ? matched[0]._id
            : {$in: matched.map((item) => item._id)};
    }

    const pageSize = Math.min(limit ?? DEFAULT_LIMIT, 50);
    const [posts, total] = await Promise.all([
        blogPostService.find(
            postFilter,
            {logger, languageCode},
            POST_POPULATE,
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
        categories: dedupeCategoriesBySlug(categories).map(mapPublicCategory),
    };
}

async function publicBlogSingle(params: PublicBlogSingleParams): Promise<PublicBlogSingleFormResponseType> {
    const {origin, languageCode, logger, slug} = params;
    logger.start(`Loading public blog post [${slug}]...`);

    const platform = isPlatformShopOrigin(origin);
    const filter: Record<string, unknown> = {slug, published: true};
    if (!platform) {
        const company = await resolveCompanyByOrigin(origin, languageCode);
        filter.company = company._id;
    } else {
        filter.company = {
            $in: (await Company.find({isActive: true}, {_id: 1}).noDeleted().lean()).map((row) => row._id),
        };
    }

    if (platform) {
        const matches = await blogPostService.find(
            filter,
            {logger, languageCode},
            POST_POPULATE,
            undefined,
            {publishedAt: -1},
            2,
        );
        if (matches.length !== 1) {
            throw apiValidationException("blog_post_not_found", "slug", [slug], languageCode);
        }
        logger.finish(`Loaded public blog post ${slug}`);
        return {post: mapPublicPost(matches[0])};
    }

    const post = await blogPostService.findOne(
        filter,
        {logger, languageCode},
        POST_POPULATE,
    );

    if (!post) {
        throw apiValidationException("blog_post_not_found", "slug", [slug], languageCode);
    }

    logger.finish(`Loaded public blog post ${slug}`);
    return {post: mapPublicPost(post)};
}

export {router};
export const basePath = "/api/auxiliary/public/blog";

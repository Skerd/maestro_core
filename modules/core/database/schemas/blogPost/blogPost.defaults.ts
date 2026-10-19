import dayjs from "dayjs";
import type {ObjectId} from "mongodb";
import BlogPost from "./blogPost";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICompany} from "@coreModule/database/schemas/company/company";
import type {CreateBlogCategoriesResult} from "@coreModule/database/schemas/blogCategory/blogCategory.defaults";

export type BlogPostSeed = {
    slug: string;
    title: string;
    categorySlug: string;
    excerpt?: string;
    /** Plain text: blank lines separate paragraphs. */
    content: string;
    /** Omit to seed a draft. */
    publishedDaysAgo?: number;
    mainImage?: ObjectId;
    imageGallery?: ObjectId[];
    /** Shown as the post's author on public sites. */
    createdBy: ObjectId;
};

/**
 * Upserts blog posts. Idempotent on `{company, slug}`. As with categories, the
 * calling module supplies the copy and resolves any images first.
 */
export async function createBlogPosts(
    parentLogger: serverLogger,
    company: ICompany,
    seeds: readonly BlogPostSeed[],
    categories: CreateBlogCategoriesResult,
): Promise<number> {
    const logger = getLogger("mongoDbInitialization-createBlogPosts", parentLogger);
    logger.start("Creating blog posts...");

    let count = 0;
    for (const seed of seeds) {
        try {
            const category = categories.bySlug[seed.categorySlug];
            if (!category) {
                logger.warn(`Skipping blog post '${seed.slug}': category '${seed.categorySlug}' was not seeded.`);
                continue;
            }

            const published = seed.publishedDaysAgo != null;
            const payload = {
                category: category._id,
                title: seed.title,
                slug: seed.slug,
                excerpt: seed.excerpt,
                content: seed.content,
                mainImage: seed.mainImage,
                imageGallery: seed.imageGallery ?? [],
                published,
                publishedAt: published ? dayjs().subtract(seed.publishedDaysAgo!, "day").toDate() : undefined,
                company: company._id,
                createdBy: seed.createdBy,
            };

            const doc = await BlogPost.findOne({company: company._id, slug: seed.slug});
            if (doc) {
                doc.set(payload);
                await doc.save();
            } else {
                await BlogPost.create(payload);
            }
            count += 1;
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            logger.err(`Error creating blog post '${seed.slug}': ${message}`);
        }
    }

    logger.finish("Finished creating blog posts!", count);
    return count;
}

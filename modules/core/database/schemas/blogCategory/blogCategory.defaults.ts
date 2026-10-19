import type {HydratedDocument} from "mongoose";
import BlogCategory, {type IBlogCategory} from "./blogCategory";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICompany} from "@coreModule/database/schemas/company/company";

export type BlogCategorySeed = {
    name: string;
    slug: string;
    description?: string;
};

export type CreateBlogCategoriesResult = {
    bySlug: Record<string, HydratedDocument<IBlogCategory>>;
};

/**
 * Upserts blog categories. Idempotent on `{company, slug}`.
 *
 * Core owns the schema but not the copy: the module whose public site shows the
 * blog (e.g. the eCommerce shop) passes its own seeds.
 */
export async function createBlogCategories(
    parentLogger: serverLogger,
    company: ICompany,
    seeds: readonly BlogCategorySeed[],
): Promise<CreateBlogCategoriesResult> {
    const logger = getLogger("mongoDbInitialization-createBlogCategories", parentLogger);
    logger.start("Creating blog categories...");

    const bySlug: CreateBlogCategoriesResult["bySlug"] = {};
    for (const seed of seeds) {
        try {
            const payload = {
                name: seed.name,
                slug: seed.slug,
                description: seed.description,
                company: company._id,
                createdBy: company.createdBy,
            };

            let doc = await BlogCategory.findOne({company: company._id, slug: seed.slug});
            if (doc) {
                doc.set(payload);
                await doc.save();
            } else {
                doc = await BlogCategory.create(payload);
            }
            bySlug[seed.slug] = doc;
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            logger.err(`Error creating blog category '${seed.slug}': ${message}`);
        }
    }

    logger.finish("Finished creating blog categories!", Object.keys(bySlug).length);
    return {bySlug};
}

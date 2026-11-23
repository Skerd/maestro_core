import {ObjectId} from "mongodb";
import type {PortalBrowseResponse} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";
import {companyService} from "@coreModule/database/schemas/company/company.service";

/**
 * Marks the items of companies the platform verified (D178), with one lookup for the page. Items name their company
 * by its portal slug: the site slug, else the company id.
 */
export async function markVerifiedCompanies(items: PortalBrowseResponse["data"][number]["items"]): Promise<void> {
    const slugs = [...new Set(items.map((item) => item.company.slug))];
    if (slugs.length === 0) return;
    const ids = slugs.filter((slug) => ObjectId.isValid(slug)).map((slug) => new ObjectId(slug));
    const verified = await companyService.find(
        {$or: [{siteSlug: {$in: slugs}}, {_id: {$in: ids}}], verifiedAt: {$ne: null}},
        {}, undefined, "_id siteSlug",
    );
    const verifiedSlugs = new Set(verified.flatMap((company) => [String(company._id), company.siteSlug ?? ""]));
    for (const item of items) {
        if (verifiedSlugs.has(item.company.slug)) item.company.verified = true;
    }
}

/**
 * sitemap.xml and robots.txt for each portal host (D181). The apex lists its home, blog, business page, city landing
 * pages, every listed company's site and their items; a company's own site lists its own. Until the platform turns
 * search indexing on (P23.11), robots.txt keeps every crawler out.
 *
 * @module portalSitemap
 */

import {portalCitySlug} from "armonia/src/modules/core/helpers/slug";
import {PORTAL_SEARCH_INDEXING} from "@coreModule/environment";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import {portalCompanyRefs} from "@coreModule/utilities/marketing/portalCompanies";
import {escapeHtml} from "./portalPageHtml";
import {SUPPORTED_LOCALES} from "armonia/src/modules/core/constants";
import {PORTAL_PRIVATE_PATHS, withAddressLanguage, type PortalBlogReader} from "./portalPage";
import {hostCompany, inPortalScope, sectionCompanies} from "./portalBrowse";
import {portalLandings} from "./portalLandings";
import {listPortalProviders} from "./portalProviderRegistry";

/** One sitemap file holds at most 50,000 addresses: each page is listed in 6 versions (5 languages and the default). */
const MAX_URLS = 8000;
const PAGE = 200;

export function portalRobots(baseUrl: string): string {
    if (!PORTAL_SEARCH_INDEXING) return "User-agent: *\nDisallow: /\n";
    return [
        "User-agent: *",
        ...PORTAL_PRIVATE_PATHS.map((path) => `Disallow: ${path}`),
        "Disallow: /api/",
        // Pictures stay findable in image search.
        "Allow: /api/auxiliary/media/",
        `Sitemap: ${baseUrl}/sitemap.xml`,
        "",
    ].join("\n");
}

type SitemapRequest = {host: string; baseUrl: string; languageCode: string; logger: serverLogger};

/** The host's sitemap, or null when the host is not a portal site. */
export async function portalSitemap(request: SitemapRequest, blog: PortalBlogReader): Promise<string | null> {
    const host = await hostCompany(request.host, request.languageCode).catch(() => null);
    if (!host) return null;
    const {scope} = host;
    const paths = new Set<string>(["/"]);
    const add = (path: string) => {
        if (paths.size < MAX_URLS) paths.add(path);
    };

    const posts = await blog.scope(request.host, () => blog.list({origin: request.host, languageCode: request.languageCode, logger: request.logger, limit: 50}))
        .catch(() => ({posts: []}));
    if (posts.posts.length > 0) add("/blog");
    for (const post of posts.posts) add(`/blog/${encodeURIComponent(post.slug)}`);

    await inPortalScope(scope, async () => {
        if (!scope.companyId) {
            add("/business");
            for (const landing of await portalLandings(scope, request.languageCode)) {
                const provider = listPortalProviders().find((candidate) => candidate.key === landing.section);
                if (provider) add(`/${provider.sitePath}/in/${portalCitySlug(landing.city)}`);
            }
        }
        for (const provider of listPortalProviders()) {
            const {ids} = await sectionCompanies(provider, scope);
            if (ids.length === 0) continue;
            // The section's own address on a company's site; on the apex, each company's site in the section.
            if (scope.companyId) add(`/${provider.sitePath}`);
            else for (const company of (await portalCompanyRefs(ids)).values()) add(`/${provider.sitePath}/${company.slug}`);
            for (const kind of provider.kinds) {
                for (let skip = 0; paths.size < MAX_URLS; skip += PAGE) {
                    const {items, total} = await provider.browse({kind, scope, companyIds: ids, skip, limit: PAGE, filters: {}, languageCode: request.languageCode});
                    for (const item of items) {
                        add(scope.companyId ? `/${provider.sitePath}${item.path}` : `/${provider.sitePath}/${item.company.slug}${item.path}`);
                    }
                    if (items.length === 0 || skip + PAGE >= total) break;
                }
            }
        }
    });

    // Every page in each language (`?lang=`, D181) and its default address, each naming all the others (hreflang).
    const urls = [...paths].flatMap((path) => {
        const versions = [
            ...SUPPORTED_LOCALES.map((locale) => ({hreflang: locale, href: `${request.baseUrl}${withAddressLanguage(path, locale)}`})),
            {hreflang: "x-default", href: `${request.baseUrl}${withAddressLanguage(path)}`},
        ];
        const links = versions.map((version) => `<xhtml:link rel="alternate" hreflang="${version.hreflang}" href="${escapeHtml(version.href)}"/>`).join("");
        return versions.map((version) => `  <url><loc>${escapeHtml(version.href)}</loc>${links}</url>`);
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;
}

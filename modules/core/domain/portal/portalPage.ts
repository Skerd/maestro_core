/**
 * What a portal page is (D181), for the HTML head that search engines and link previews read and the plain copy of its
 * content crawlers get: every page of the apex and of a company's own site, worked out from its address alone, from the
 * same section providers the portal's catalog asks. A page the portal keeps private, or one this cannot place, is never
 * offered to search engines.
 *
 * @module portalPage
 */

import type {PortalCatalogItem, PortalLanding} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";
import type {SupportedLocale} from "armonia/src/modules/core/constants";
import {portalCitySlug} from "armonia/src/modules/core/helpers/slug";
import type {PublicBlogFormResponseType} from "armonia/src/modules/core/api/auxiliary/public/blog/blog.form.response.type";
import type {PublicBlogSingleFormResponseType} from "armonia/src/modules/core/api/auxiliary/public/blog/blogSingle.form.response.type";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import {PORTAL_SEARCH_INDEXING} from "@coreModule/environment";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import {applyPlaceholders, loadEmailStrings, resolveEmailLocaleTag} from "@coreModule/utilities/emails/emailLocale";
import {findPortalSiteCompany, portalCompanyProfile, portalSlug, type PortalScope} from "@coreModule/utilities/marketing/portalCompanies";
import {publicMediaUrl} from "@coreModule/utilities/media/publicMediaUrl";
import {hostCompany, inPortalScope, sectionCompanies} from "./portalBrowse";
import {portalLandings} from "./portalLandings";
import {listPortalProviders} from "./portalProviderRegistry";
import type {PortalProvider} from "./portalProvider.types";

export type PortalPageLink = {href: string; text: string; detail?: string};

export type PortalPage = {
    language: SupportedLocale;
    /** The whole `<title>`. */
    title: string;
    description: string;
    /** The page's absolute address as search engines should list it. */
    canonical: string;
    /** Absolute address of the share preview's picture. */
    image?: string;
    siteName: string;
    indexable: boolean;
    /** The share preview's kind (`og:type`). */
    type: "website" | "article" | "product";
    jsonLd: Record<string, unknown>[];
    /** The plain copy: a heading, a line, and the page's links. */
    heading: string;
    intro?: string;
    links: PortalPageLink[];
};

export type PortalPageRequest = {
    /** The host the visitor asked for, without port (what tells the apex from a company's site). */
    host: string;
    /** Scheme, host and port, for absolute addresses. */
    baseUrl: string;
    /** The page's path, query included. */
    path: string;
    languageCode: string;
    logger: serverLogger;
};

/** The public blog, read through its own route's functions (they live with its router). */
export type PortalBlogReader = {
    scope: <T>(origin: string, read: () => Promise<T>) => Promise<T>;
    list: (params: {origin: string; languageCode: string; logger: serverLogger; limit?: number; page?: number}) => Promise<PublicBlogFormResponseType>;
    single: (params: {origin: string; languageCode: string; logger: serverLogger; slug: string}) => Promise<PublicBlogSingleFormResponseType>;
};

/** Pages behind sign-in, a step of signing in, or one visitor's own: never listed (robots.txt says the same). */
export const PORTAL_PRIVATE_PATHS = ["/account", "/login", "/signup", "/forgot-password", "/reset-password", "/activate", "/saved-searches", "/business/new"];
/** Links in a page's plain copy, enough for a crawler to reach the rest. */
const COPY_ITEMS = 48;

type PageContext = {
    request: PortalPageRequest;
    company: ICompany;
    scope: PortalScope;
    language: SupportedLocale;
    words: Record<string, string>;
    siteName: string;
    blog: PortalBlogReader;
};

/** The page at `request.path`, or null when the host is not a portal site (the gateway then serves the app as it is). */
export async function describePortalPage(request: PortalPageRequest, blog: PortalBlogReader): Promise<PortalPage | null> {
    const host = await hostCompany(request.host, request.languageCode).catch(() => null);
    if (!host) return null;
    const language = resolveEmailLocaleTag(request.languageCode);
    const context: PageContext = {
        request,
        company: host.company,
        scope: host.scope,
        language,
        words: loadEmailStrings(["portalPage"], language),
        siteName: host.company.name,
        blog,
    };
    return inPortalScope(host.scope, () => routePage(context));
}

async function routePage(context: PageContext): Promise<PortalPage> {
    const url = new URL(context.request.path, context.request.baseUrl);
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    const [first, second] = segments;
    if (!first) return homePage(context, url.searchParams);
    if (PORTAL_PRIVATE_PATHS.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))) return privatePage(context, url.pathname);
    if (first === "blog") return second ? blogPostPage(context, second) : blogPage(context);
    if (first === "business" && !context.scope.companyId && segments.length === 1) return businessPage(context);
    const provider = listPortalProviders().find((candidate) => candidate.sitePath === first);
    if (!provider) return privatePage(context, url.pathname);
    const rest = segments.slice(1);
    if (context.scope.companyId) return companySitePage(context, provider, context.company, rest, url.search);
    if (rest.length === 0) return kindPage(context, provider, provider.kinds[0]);
    if (rest[0] === "in" && rest.length === 2) return landingPage(context, provider, rest[1]);
    const listed = await listedCompany(provider, rest[0], context);
    if (!listed) return privatePage(context, url.pathname);
    return companySitePage(context, provider, listed, rest.slice(1), url.search);
}

function base(context: PageContext, pathname: string): Pick<PortalPage, "language" | "siteName" | "canonical" | "indexable" | "type" | "jsonLd" | "links"> {
    return {
        language: context.language,
        siteName: context.siteName,
        canonical: `${context.request.baseUrl}${pathname}`,
        indexable: PORTAL_SEARCH_INDEXING,
        type: "website",
        jsonLd: [],
        links: [],
    };
}

/** The apex's line is the portal's own (the platform company's description is written for its staff); a company's site has its own. */
function siteTagline(context: PageContext): string {
    if (!context.scope.companyId) return context.words.tagline;
    return context.company.description?.trim()
        || applyPlaceholders(context.words.companyTagline, {company: context.company.name, site: context.siteName});
}

function privatePage(context: PageContext, pathname: string): PortalPage {
    return {...base(context, pathname), indexable: false, title: context.siteName, description: siteTagline(context), heading: context.siteName};
}

/** A catalog item's page, on the apex inside its company's site, on a company's own host inside its section. */
function itemHref(context: PageContext, provider: PortalProvider, item: PortalCatalogItem): string {
    return context.scope.companyId ? `/${provider.sitePath}${item.path}` : `/${provider.sitePath}/${item.company.slug}${item.path}`;
}

function itemLink(context: PageContext, provider: PortalProvider, item: PortalCatalogItem): PortalPageLink {
    return {href: itemHref(context, provider, item), text: item.title, detail: [item.subtitle, item.city, item.company.name].filter(Boolean).join(" · ")};
}

function absolute(context: PageContext, address: string | undefined): string | undefined {
    if (!address) return undefined;
    return address.startsWith("/") ? `${context.request.baseUrl}${address}` : address;
}

/** The first items of every kind of every section (the home page), or of one section's companies in a city. */
async function sectionItems(context: PageContext, provider: PortalProvider, companyIds: Awaited<ReturnType<typeof sectionCompanies>>["ids"], city: string | undefined, limit: number): Promise<PortalPageLink[]> {
    if (companyIds.length === 0) return [];
    const pages = await Promise.all(provider.kinds.map((kind) => provider.browse({
        kind, scope: context.scope, companyIds, city, skip: 0, limit, filters: {}, languageCode: context.language,
    })));
    return pages.flatMap((page) => page.items.map((item) => itemLink(context, provider, item)));
}

async function homePage(context: PageContext, query: URLSearchParams): Promise<PortalPage> {
    const kind = query.get("kind");
    const provider = kind ? listPortalProviders().find((candidate) => candidate.kinds.includes(kind)) : undefined;
    // A search or a filter is one visitor's question, not a page to list.
    const narrowed = [...query.keys()].some((key) => key !== "kind");
    if (provider && kind) return {...await kindPage(context, provider, kind), ...(narrowed ? {indexable: false} : {})};
    const landings = await portalLandings(context.scope, context.language);
    const perSection = await Promise.all(listPortalProviders().map(async (candidate) => {
        const {ids} = await sectionCompanies(candidate, context.scope);
        return sectionItems(context, candidate, ids, undefined, 8);
    }));
    const description = siteTagline(context);
    return {
        ...base(context, "/"),
        indexable: PORTAL_SEARCH_INDEXING && !narrowed,
        title: context.siteName,
        description,
        image: absolute(context, publicMediaUrl(context.company.logo)),
        jsonLd: [{"@context": "https://schema.org", "@type": "WebSite", name: context.siteName, url: `${context.request.baseUrl}/`}],
        heading: context.siteName,
        intro: description,
        links: [...landingLinks(context, landings), ...perSection.flat()],
    };
}

function landingLinks(context: PageContext, landings: PortalLanding[]): PortalPageLink[] {
    return landings.flatMap((landing) => {
        const provider = listPortalProviders().find((candidate) => candidate.key === landing.section);
        if (!provider) return [];
        return [{
            href: `/${provider.sitePath}/in/${portalCitySlug(landing.city)}`,
            text: applyPlaceholders(context.words.landing, {section: provider.names[context.language].title, city: landing.city}),
            detail: String(landing.count),
        }];
    });
}

/** One kind's catalog (`/?kind=product`), the address a section's own link opens. */
async function kindPage(context: PageContext, provider: PortalProvider, kind: string): Promise<PortalPage> {
    const {ids} = await sectionCompanies(provider, context.scope);
    const page = ids.length === 0
        ? {items: []}
        : await provider.browse({kind, scope: context.scope, companyIds: ids, skip: 0, limit: COPY_ITEMS, filters: {}, languageCode: context.language});
    const names = provider.names[context.language];
    // Named as its catalog tab names it, as the browser titles the page.
    const kindName = names.kinds[kind] ?? names.title;
    return {
        ...base(context, `/?${new URLSearchParams({kind})}`),
        title: `${kindName} · ${context.siteName}`,
        description: names.description,
        heading: kindName,
        intro: names.description,
        links: page.items.map((item) => itemLink(context, provider, item)),
    };
}

/** A section in one city (`/car-rental/in/tirane`): only the landing pages the apex offers. */
async function landingPage(context: PageContext, provider: PortalProvider, citySlug: string): Promise<PortalPage> {
    const landing = (await portalLandings(context.scope, context.language))
        .find((candidate) => candidate.section === provider.key && portalCitySlug(candidate.city) === citySlug);
    const pathname = `/${provider.sitePath}/in/${citySlug}`;
    if (!landing) return privatePage(context, pathname);
    const names = provider.names[context.language];
    const {ids} = await sectionCompanies(provider, context.scope, landing.city);
    const title = applyPlaceholders(context.words.landing, {section: names.title, city: landing.city});
    const description = applyPlaceholders(context.words.landingDescription, {count: String(landing.count), city: landing.city, sectionDescription: names.description});
    return {
        ...base(context, pathname),
        title: `${title} · ${context.siteName}`,
        description,
        heading: title,
        intro: description,
        links: await sectionItems(context, provider, ids, landing.city, COPY_ITEMS),
    };
}

/** The company an apex address names (`/car-rental/{slug}`), while the section lists it. */
async function listedCompany(provider: PortalProvider, slug: string, context: PageContext): Promise<ICompany | null> {
    const company = await findPortalSiteCompany(slug, "core", context.language).catch(() => null);
    if (!company) return null;
    const ids = await provider.companyIds(context.scope);
    return ids.some((id) => id.equals(company._id)) ? company : null;
}

/** A company's site in one section: its home, or one of its items. */
async function companySitePage(context: PageContext, provider: PortalProvider, company: ICompany, rest: string[], search: string): Promise<PortalPage> {
    const sitePath = context.scope.companyId ? `/${provider.sitePath}` : `/${provider.sitePath}/${portalSlug({_id: company._id, siteSlug: company.siteSlug})}`;
    if (rest.length === 0) {
        const profile = await portalCompanyProfile(company);
        const description = company.description?.trim()
            || applyPlaceholders(context.words.companyTagline, {company: company.name, site: context.siteName});
        const links = await sectionItems(context, provider, [company._id], undefined, COPY_ITEMS);
        const address = profile.addresses?.[0];
        return {
            ...base(context, sitePath),
            // As the portal titles it in the browser: the page, then the site (the company itself on its own host).
            title: context.scope.companyId ? company.name : `${company.name} · ${context.siteName}`,
            description,
            image: absolute(context, profile.logo),
            jsonLd: [{
                "@context": "https://schema.org",
                "@type": "LocalBusiness",
                name: company.name,
                url: `${context.request.baseUrl}${sitePath}`,
                ...(profile.logo ? {logo: absolute(context, profile.logo)} : {}),
                ...(profile.phoneNumber ? {telephone: profile.phoneNumber} : {}),
                ...(address ? {address: {
                    "@type": "PostalAddress",
                    ...(address.street ? {streetAddress: address.street} : {}),
                    ...(address.postalCode ? {postalCode: address.postalCode} : {}),
                    ...(address.city?.name ? {addressLocality: address.city.name} : {}),
                    ...(address.country?.code ? {addressCountry: address.country.code} : {}),
                }} : {}),
            }],
            heading: company.name,
            intro: description,
            links,
        };
    }
    const itemPath = `/${rest.map((segment) => encodeURIComponent(segment)).join("/")}${search}`;
    const found = await provider.itemAt?.({scope: context.scope, companyId: company._id, path: itemPath, languageCode: context.language});
    // A page this cannot place (a cart, a search, a booking step) is the company's, never listed on its own.
    if (!found) return {...privatePage(context, `${sitePath}${itemPath}`), title: context.scope.companyId ? company.name : `${company.name} · ${context.siteName}`};
    const {item} = found;
    const description = [found.description ?? item.subtitle, item.city, company.name].filter(Boolean).join(" · ");
    const canonical = `${sitePath}${item.path}`;
    return {
        ...base(context, canonical),
        title: `${item.title} · ${context.siteName}`,
        description,
        image: absolute(context, item.image),
        type: "product",
        jsonLd: [{
            "@context": "https://schema.org",
            "@type": found.schemaType,
            name: item.title,
            url: `${context.request.baseUrl}${canonical}`,
            ...(item.image ? {image: absolute(context, item.image)} : {}),
            ...(description ? {description} : {}),
            ...(item.price ? {offers: {"@type": "Offer", price: item.price.amount, priceCurrency: item.price.currency}} : {}),
            ...(item.rating ? {aggregateRating: {"@type": "AggregateRating", ratingValue: item.rating.average, reviewCount: item.rating.count}} : {}),
            provider: {"@type": "LocalBusiness", name: company.name},
        }],
        heading: item.title,
        intro: description,
        links: [{href: sitePath, text: company.name}],
    };
}

async function blogPage(context: PageContext): Promise<PortalPage> {
    const {request} = context;
    const {posts} = await context.blog.scope(request.host, () => context.blog.list({origin: request.host, languageCode: context.language, logger: request.logger, limit: COPY_ITEMS}));
    const description = applyPlaceholders(context.words.blogDescription, {site: context.siteName});
    return {
        ...base(context, "/blog"),
        title: `${context.words.blog} · ${context.siteName}`,
        description,
        heading: context.words.blog,
        intro: description,
        links: posts.map((post) => ({href: `/blog/${encodeURIComponent(post.slug)}`, text: post.title, detail: post.excerpt})),
    };
}

async function blogPostPage(context: PageContext, slug: string): Promise<PortalPage> {
    const {request} = context;
    const pathname = `/blog/${encodeURIComponent(slug)}`;
    const found = await context.blog.scope(request.host, () => context.blog.single({origin: request.host, languageCode: context.language, logger: request.logger, slug}))
        .catch(() => null);
    if (!found) return privatePage(context, pathname);
    const {post} = found;
    const description = post.excerpt || applyPlaceholders(context.words.blogDescription, {site: context.siteName});
    return {
        ...base(context, pathname),
        title: `${post.title} · ${context.siteName}`,
        description,
        image: absolute(context, post.mainImage),
        type: "article",
        jsonLd: [{
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            headline: post.title,
            url: `${request.baseUrl}${pathname}`,
            ...(post.mainImage ? {image: absolute(context, post.mainImage)} : {}),
            ...(post.publishedAt ? {datePublished: post.publishedAt} : {}),
            ...(post.authorName ? {author: {"@type": "Person", name: post.authorName}} : {}),
            publisher: {"@type": "Organization", name: post.seller?.name ?? context.siteName},
        }],
        heading: post.title,
        intro: description,
        links: [{href: "/blog", text: context.words.blog}],
    };
}

function businessPage(context: PageContext): PortalPage {
    const description = applyPlaceholders(context.words.businessDescription, {site: context.siteName});
    return {
        ...base(context, "/business"),
        title: `${context.words.business} · ${context.siteName}`,
        description,
        heading: context.words.business,
        intro: description,
        links: listPortalProviders().map((provider) => ({href: `/${provider.sitePath}`, text: provider.names[context.language].title, detail: provider.names[context.language].description})),
    };
}

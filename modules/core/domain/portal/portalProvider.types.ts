import type {ObjectId} from "mongodb";
import type {PortalCatalogItem} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";
import type {PortalBrowseFilters, PortalSort} from "armonia/src/modules/core/api/portal/public/portal/portalBrowse.form.validator";
import type {SupportedLocale} from "armonia/src/modules/core/constants";
import type {PortalScope} from "@coreModule/utilities/marketing/portalCompanies";

export type PortalBrowseParams = {
    kind: string;
    /** The host: one company's own site, or every listed company (the apex). */
    scope: PortalScope;
    /** The companies to list items of, already narrowed to `city`. */
    companyIds: ObjectId[];
    query?: string;
    /** The "where" of the search, for sections that also place each item (e.g. a car's pickup location). */
    city?: string;
    priceMin?: number;
    priceMax?: number;
    sort?: PortalSort;
    skip: number;
    limit: number;
    /** The kind's own filters (`f.<name>` on the home page); each provider reads its own. */
    filters: PortalBrowseFilters;
    languageCode: string;
};

/**
 * What core asks a section about items listed after a date (D178, P23.7): the items of one kind that a browse query
 * finds and that were listed after `since`, newest first, at most `limit` of them, with how many there are. The daily
 * saved-search alert asks with a person's saved query and the time of their last alert. A person's Saved tab asks with
 * `ids` (and the epoch as `since`) to show the items they keep as the catalog lists them now.
 */
export type PortalNewSinceContext = {
    kind: string;
    scope: PortalScope;
    /** The companies to look in, already narrowed to `city`. */
    companyIds: ObjectId[];
    query?: string;
    city?: string;
    priceMin?: number;
    priceMax?: number;
    filters: PortalBrowseFilters;
    /** Only items listed after this instant. */
    since: Date;
    /** Only these items, by their catalog `id`. */
    ids?: readonly string[];
    limit: number;
    languageCode: string;
};

/** What core asks a section about one page of a company's site (D181): the item it shows, by the page's path. */
export type PortalItemAtContext = {
    scope: PortalScope;
    /** The company whose site the page belongs to. */
    companyId: ObjectId;
    /** The page's path inside the company's site, query included, as the catalog item's `path` writes it. */
    path: string;
    languageCode: string;
};

/** One item's page, for its title, description, share preview and structured data (D181). */
export type PortalItemPage = {
    item: PortalCatalogItem;
    /** A longer text than the card's subtitle, when the item has one (plain text). */
    description?: string;
    /** The schema.org type the page's structured data uses, e.g. `Product`, `Service`, `Residence`. */
    schemaType: string;
};

/**
 * One portal section, contributed by the module that owns it (shop, car rental, …).
 * Core asks it which companies it shows and what they offer; it never imports the module.
 */
export type PortalProvider = {
    /** Section key: `shop`, `carRental`, `dentalClinic`, `properties`. */
    key: string;
    /** Display order on the portal (lower first). */
    order: number;
    /** The section's address on the portal, e.g. `car-rental`: the same as its sinfonia portal contribution's `path` (D181). */
    sitePath: string;
    /** The section's name and one-line description in each language, as the portal's section tabs show them (D181). */
    names: Record<SupportedLocale, {title: string; description: string}>;
    /** Item kinds the section lists in the home catalog. */
    kinds: readonly string[];
    /** Companies this section shows in `scope`: opted in on the apex, the company itself on its own site. */
    companyIds: (scope: PortalScope) => Promise<ObjectId[]>;
    /** City names per company id, for cards and the "where" filter. */
    citiesByCompany: (companyIds: ObjectId[]) => Promise<Map<string, string[]>>;
    /** A page of one kind's items of these companies. */
    browse: (params: PortalBrowseParams) => Promise<{items: PortalCatalogItem[]; total: number}>;
    /**
     * Optional (CORE-03, D178): the kind's items listed after a date. A section without it sends no saved-search
     * alerts, and the items people keep from it are not shown in their Saved tab.
     */
    newSince?: (context: PortalNewSinceContext) => Promise<{items: PortalCatalogItem[]; total: number}>;
    /**
     * Optional (CORE-03, D181): the item a page of a company's site shows, for the page's head that search engines and
     * link previews read. Without it, an item page reads as its company's site.
     */
    itemAt?: (context: PortalItemAtContext) => Promise<PortalItemPage | undefined>;
};

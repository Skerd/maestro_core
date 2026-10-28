import type {ObjectId} from "mongodb";
import type {PortalCatalogItem} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";
import type {PortalBrowseFilters, PortalSort} from "armonia/src/modules/core/api/portal/public/portal/portalBrowse.form.validator";
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
 * One portal section, contributed by the module that owns it (shop, car rental, …).
 * Core asks it which companies it shows and what they offer; it never imports the module.
 */
export type PortalProvider = {
    /** Section key: `shop`, `carRental`, `dentalClinic`, `properties`. */
    key: string;
    /** Display order on the portal (lower first). */
    order: number;
    /** Item kinds the section lists in the home catalog. */
    kinds: readonly string[];
    /** Companies this section shows in `scope`: opted in on the apex, the company itself on its own site. */
    companyIds: (scope: PortalScope) => Promise<ObjectId[]>;
    /** City names per company id, for cards and the "where" filter. */
    citiesByCompany: (companyIds: ObjectId[]) => Promise<Map<string, string[]>>;
    /** A page of one kind's items of these companies. */
    browse: (params: PortalBrowseParams) => Promise<{items: PortalCatalogItem[]; total: number}>;
};

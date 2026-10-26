import type {ObjectId} from "mongodb";
import type {PortalSearchItem} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";

/**
 * One portal section, contributed by the module that owns it (shop, car rental, …).
 * Core asks it which companies it lists and what matches a search; it never imports the module.
 */
export type PortalProvider = {
    /** Section key: `shop`, `carRental`, `dentalClinic`, `properties`. */
    key: string;
    /** Display order on the portal home (lower first). */
    order: number;
    /** Portal path of a company's pages in this section, e.g. `/car-rental/<slug>`. */
    companyPath: (company: {_id: string; slug: string}) => string;
    /** Companies this section may show: portal-eligible and opted in. */
    listedCompanyIds: () => Promise<ObjectId[]>;
    /** City names per listed company id, for cards and the "where" filter. */
    citiesByCompany: (companyIds: ObjectId[]) => Promise<Map<string, string[]>>;
    /** Items of these companies matching `query` (companies themselves are matched by core). */
    search: (params: {query: string; companyIds: ObjectId[]; limit: number; languageCode: string}) => Promise<PortalSearchItem[]>;
};

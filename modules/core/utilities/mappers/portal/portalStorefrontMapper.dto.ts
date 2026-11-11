import type {PortalCurrency, PortalSeller} from "armonia/src/modules/core/api/portal/public/portal/portal.dto";

/** Currency fields a storefront needs to format a price; populate a price's currency with this select. */
export const PORTAL_CURRENCY_SELECT = "symbol abbreviation decimalPlaces";

function mediaId(value: unknown): string | undefined {
    if (!value) return undefined;
    if (typeof value === "object" && "_id" in value && value._id) return String(value._id);
    return String(value);
}

/** A populated currency as a storefront shows it; undefined when the price has none (shown as a plain number). */
export function toPortalCurrency(value: any): PortalCurrency | undefined {
    if (!value || typeof value !== "object" || !value._id) return undefined;
    return {
        _id: value._id.toString(),
        symbol: value.symbol,
        abbreviation: value.abbreviation,
        decimalPlaces: value.decimalPlaces,
    };
}

/** A populated seller company (name, logo, site slug/host) as storefront cards show it; undefined without a name. */
export function toPortalSeller(company: any): PortalSeller | undefined {
    if (!company || typeof company !== "object" || !company._id) return undefined;
    const name = typeof company.name === "string" ? company.name.trim() : "";
    if (!name) return undefined;
    const seller: PortalSeller = {_id: company._id.toString(), name};
    const logo = mediaId(company.logo);
    if (logo) seller.logo = logo;
    if (typeof company.siteSlug === "string" && company.siteSlug.trim()) {
        seller.siteSlug = company.siteSlug.trim();
    }
    if (typeof company.siteHost === "string" && company.siteHost.trim()) {
        seller.siteHost = company.siteHost.trim();
    }
    return seller;
}

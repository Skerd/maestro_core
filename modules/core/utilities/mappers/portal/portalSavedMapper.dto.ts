import type {IPortalFavourite} from "@coreModule/database/schemas/portalFavourite/portalFavourite";
import type {IPortalSavedSearch} from "@coreModule/database/schemas/portalSavedSearch/portalSavedSearch";
import type {PortalSavedSearch} from "armonia/src/modules/core/api/portal/private/saved/portalSaved.dto";

export function portalSavedSearchToDTO(search: IPortalSavedSearch): PortalSavedSearch {
    return {
        _id: search._id.toString(),
        label: search.label,
        kind: search.kind,
        query: search.query,
        city: search.city,
        priceMin: search.priceMin,
        priceMax: search.priceMax,
        filters: search.filters ?? {},
        alerts: search.alerts,
    };
}

/** A kept item as the hearts name it: `<kind>:<id>`. */
export function portalFavouriteKey(favourite: Pick<IPortalFavourite, "kind" | "itemId">): string {
    return `${favourite.kind}:${favourite.itemId}`;
}

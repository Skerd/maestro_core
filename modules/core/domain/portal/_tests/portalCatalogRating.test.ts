import {describe, expect, it} from "vitest";
import {catalogRating} from "@coreModule/domain/portal/portalCatalog";

/* D178: catalog cards show a rating only when the item has reviews. */

describe("catalogRating", () => {
    it("keeps one decimal of the average and the count", () => {
        expect(catalogRating(4.6666, 3)).toEqual({rating: {average: 4.7, count: 3}});
    });

    it("gives nothing without reviews or without an average", () => {
        expect(catalogRating(4.5, 0)).toEqual({});
        expect(catalogRating(undefined, 2)).toEqual({});
        expect(catalogRating(Number.NaN, 2)).toEqual({});
    });
});

import {afterEach, describe, expect, it} from "vitest";
import {
    clearSelfServeBusinessTypes,
    findSelfServeBusinessType,
    registerSelfServeBusinessTypes,
    selfServeBusinessTypes,
} from "@coreModule/domain/company/selfServeBusinessTypes";

/* D178: modules declare the business types a person may create on the portal; core keeps them by key (core fixtures only). */

afterEach(() => clearSelfServeBusinessTypes());

describe("self-serve business types", () => {
    it("keeps each module's types under the module's name, in load order", () => {
        registerSelfServeBusinessTypes("fixtureRental", [{key: "rental", modules: ["fixtureRental"]}]);
        registerSelfServeBusinessTypes("fixtureShop", [{key: "shop", modules: ["fixtureShop", "fixturePayments"]}]);

        expect(selfServeBusinessTypes().map(({key, module}) => ({key, module}))).toEqual([
            {key: "rental", module: "fixtureRental"},
            {key: "shop", module: "fixtureShop"},
        ]);
        expect(findSelfServeBusinessType("shop")?.modules).toEqual(["fixtureShop", "fixturePayments"]);
        expect(findSelfServeBusinessType("unknown")).toBeUndefined();
    });

    it("lets a module load again without duplicating its types", () => {
        registerSelfServeBusinessTypes("fixtureRental", [{key: "rental", modules: ["fixtureRental"]}]);
        registerSelfServeBusinessTypes("fixtureRental", [{key: "rental", modules: ["fixtureRental"]}]);

        expect(selfServeBusinessTypes()).toHaveLength(1);
    });

    it("refuses a key another module already declared", () => {
        registerSelfServeBusinessTypes("fixtureRental", [{key: "rental", modules: ["fixtureRental"]}]);

        expect(() => registerSelfServeBusinessTypes("fixtureOther", [{key: "rental", modules: ["fixtureOther"]}]))
            .toThrow("already declared by 'fixtureRental'");
    });
});

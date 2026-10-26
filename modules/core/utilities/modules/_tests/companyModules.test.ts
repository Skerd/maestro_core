import {describe, expect, it, vi} from "vitest";

// The server ceiling: what this deployment installs. eCommerce and carRental pull in finance.
vi.hoisted(() => {
    process.env.ENABLED_MODULES = "core,eCommerce,carRental";
});

import {
    closeCompanyModules,
    companyModuleClause,
    effectiveCompanyModules,
    isModuleEnabledForCompany,
} from "@coreModule/utilities/modules/companyModules";

describe("company modules", () => {
    it("gives a company without a list every installed module", () => {
        expect(effectiveCompanyModules({})).toEqual(["carRental", "core", "eCommerce", "finance"]);
        expect(effectiveCompanyModules({modules: null})).toEqual(["carRental", "core", "eCommerce", "finance"]);
    });

    it("adds dependencies and core to a grant", () => {
        expect(effectiveCompanyModules({modules: ["eCommerce"]})).toEqual(["core", "eCommerce", "finance"]);
        expect(effectiveCompanyModules({modules: []})).toEqual(["core"]);
    });

    it("limits a grant to installed modules but stores it whole", () => {
        expect(closeCompanyModules(["propertyDevelopment"])).toEqual(["core", "propertyDevelopment", "propertyManagement"]);
        expect(effectiveCompanyModules({modules: ["propertyDevelopment", "propertyManagement", "core"]})).toEqual(["core"]);
    });

    it("drops names the manifest does not know instead of failing", () => {
        expect(closeCompanyModules(["carRental", "noSuchModule"])).toEqual(["carRental", "core", "finance"]);
    });

    it("always allows core", () => {
        expect(isModuleEnabledForCompany({modules: []}, "core")).toBe(true);
        expect(isModuleEnabledForCompany({modules: []}, "carRental")).toBe(false);
        expect(isModuleEnabledForCompany({modules: ["carRental"]}, "finance")).toBe(true);
    });

    it("matches no company for a module this server does not install", () => {
        expect(companyModuleClause("propertyManagement")).toEqual({_id: {$exists: false}});
        expect(companyModuleClause("carRental")).toEqual({$or: [{modules: "carRental"}, {modules: {$exists: false}}, {modules: null}]});
    });
});

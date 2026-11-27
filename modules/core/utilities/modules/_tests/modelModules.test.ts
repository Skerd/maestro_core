import {afterEach, describe, expect, it} from "vitest";
import mongoose, {Schema} from "mongoose";
import {isModelForCompany, registerModelModules, wantsInstalledModuleScope, wantsStudioSample} from "../modelModules";
import {registerPlatformListRouter} from "@coreModule/utilities/security/platformListRegistry";

describe("wantsInstalledModuleScope", () => {
    const previous = process.env.SERVER_NODE_ENV;

    afterEach(() => {
        if (previous === undefined) delete process.env.SERVER_NODE_ENV;
        else process.env.SERVER_NODE_ENV = previous;
    });

    it("accepts scope=installed only while the server is in development", () => {
        process.env.SERVER_NODE_ENV = "development";
        expect(wantsInstalledModuleScope({scope: "installed"})).toBe(true);
        expect(wantsInstalledModuleScope({scope: "company"})).toBe(false);
        expect(wantsInstalledModuleScope(undefined)).toBe(false);

        process.env.SERVER_NODE_ENV = "production";
        expect(wantsInstalledModuleScope({scope: "installed"})).toBe(false);
    });

    it("accepts the studio sample header only while the server is in development", () => {
        process.env.SERVER_NODE_ENV = "development";
        expect(wantsStudioSample("1")).toBe(true);
        expect(wantsStudioSample("0")).toBe(false);
        expect(wantsStudioSample(undefined)).toBe(false);

        process.env.SERVER_NODE_ENV = "production";
        expect(wantsStudioSample("1")).toBe(false);
    });
});

describe("isModelForCompany (D195)", () => {
    const list = mongoose.model("ModelModulesTestShopList", new Schema({}), "modelmodulestestshoplists");
    const other = mongoose.model("ModelModulesTestShopOrder", new Schema({}), "modelmodulestestshoporders");
    registerModelModules("eCommerce", [list, other]);
    registerPlatformListRouter({}, "modelmodulestestshoplists");

    it("lets the platform company see another module's platform list, and nothing else of that module", () => {
        expect(isModelForCompany(list, ["core"], {isPlatformOwner: true})).toBe(true);
        expect(isModelForCompany(other, ["core"], {isPlatformOwner: true})).toBe(false);
    });

    it("keeps other companies to their own modules", () => {
        expect(isModelForCompany(list, ["core"], {isPlatformOwner: false})).toBe(false);
        expect(isModelForCompany(list, ["core", "eCommerce"], null)).toBe(true);
    });
});

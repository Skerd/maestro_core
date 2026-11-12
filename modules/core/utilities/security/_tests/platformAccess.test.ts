import {describe, expect, it} from "vitest";
import {assertCompanyChangeAllowed} from "../platformAccess";

describe("protected companies (D143)", () => {
    const protectedCompany = {isProtected: true};

    it("refuses deactivating, hiding or removing a module of a protected company", () => {
        for (const change of [{deactivate: true}, {hideFromPortal: true}, {removedModules: ["widgets"]}]) {
            expect(() => assertCompanyChangeAllowed(protectedCompany, change, "en-US")).toThrow(
                expect.objectContaining({error_code: "company_is_protected"}),
            );
        }
    });

    it("allows adding modules, showing it on the portal, and any change to other companies", () => {
        expect(() => assertCompanyChangeAllowed(protectedCompany, {removedModules: [], hideFromPortal: false}, "en-US")).not.toThrow();
        expect(() => assertCompanyChangeAllowed({isProtected: false}, {deactivate: true, removedModules: ["widgets"]}, "en-US")).not.toThrow();
    });
});

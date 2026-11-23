import {describe, expect, it} from "vitest";
import {publicPersonName} from "@coreModule/utilities/helpers/publicName";

describe("publicPersonName (SEC-06)", () => {
    it("shows the first name and the last name's initial", () => {
        expect(publicPersonName(" Gent ", "marku")).toBe("Gent M.");
    });

    it("shows the first name alone when there is no last name", () => {
        expect(publicPersonName("Ada", "  ")).toBe("Ada");
    });
});

import {describe, expect, it} from "vitest";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {listDisplayName, listNameKey, listSearchText} from "@coreModule/utilities/helpers/listNames";

// D195, D196: platform list rows carry their names in the 5 panel languages.
describe("platform list names", () => {
    const row = {name: "Plumbing", names: {en: "Plumbing", sq: "Hidraulikë", de: "Sanitär", fr: "", it: "Idraulica"}};

    it("pick the request's language, else the English name", () => {
        expect(requestContext.run({languageCode: "sq-AL"}, () => listDisplayName(row))).toBe("Hidraulikë");
        expect(listDisplayName(row, "de-CH")).toBe("Sanitär");
        expect(listDisplayName(row, "fr-FR")).toBe("Plumbing");
        expect(listDisplayName({name: "Plumbing"}, "it-IT")).toBe("Plumbing");
        expect(listDisplayName(row)).toBe("Plumbing");
    });

    it("map panel language codes to name keys", () => {
        expect(listNameKey("it-IT")).toBe("it");
        expect(listNameKey("es-ES")).toBe("en");
        expect(listNameKey(undefined)).toBe("en");
    });

    it("search every language once, lower-cased", () => {
        expect(listSearchText(row.name, row.names)).toBe("plumbing | hidraulikë | sanitär | idraulica");
        expect(listSearchText("Plumbing", undefined)).toBe("plumbing");
    });
});

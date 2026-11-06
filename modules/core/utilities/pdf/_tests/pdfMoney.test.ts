import {describe, expect, it} from "vitest";
import {pdfMoney} from "@coreModule/utilities/pdf/pdfWriter";

describe("pdfMoney (TD-B38)", () => {
    it("prints two decimals unless told otherwise", () => {
        expect(pdfMoney(1234.5, "EUR")).toBe("EUR 1,234.50");
        expect(pdfMoney(7)).toBe("7.00");
    });

    it("prints the currency's own decimals", () => {
        expect(pdfMoney(1234, "JPY", 0)).toBe("JPY 1,234");
        expect(pdfMoney(1.2345, "KWD", 3)).toBe("KWD 1.235");
    });
});

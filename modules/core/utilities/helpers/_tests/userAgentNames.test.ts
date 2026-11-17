import {describe, expect, it} from "vitest";
import {browserAndSystem} from "@coreModule/utilities/helpers/userAgent";
import {cityViews} from "@coreModule/database/schemas/city/city.views";
import {stateViews} from "@coreModule/database/schemas/state/state.views";
import {countryViews} from "@coreModule/database/schemas/country/country.views";
import {currencyViews} from "@coreModule/database/schemas/currency/currency.views";
import {requestSheetGroup} from "@coreModule/database/schemas/shared/requestSheetGroup";

const chromeOnMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

// TD-F119: active sessions were titled by a session UUID with the raw user agent. The "Request & approval" block stays
// at the bottom of a platform list sheet, after Lifecycle (the architect's choice, 2026-11-17).
describe("session and request presentation", () => {
    it("names the browser and system a user agent names, and nothing for one it does not", () => {
        expect(browserAndSystem(chromeOnMac)).toEqual({browser: "Chrome", os: "macOS"});
        expect(browserAndSystem("curl/8.7.1")).toEqual({});
        expect(browserAndSystem("")).toEqual({});
    });

    it("ends every platform list sheet with its request block", () => {
        for (const views of [cityViews, stateViews, countryViews, currencyViews]) {
            const sheet = views.find((view: {viewType?: string}) => view.viewType === "sheet") as {nodes: unknown[]};
            expect(sheet.nodes.at(-1)).toBe(requestSheetGroup);
        }
    });
});

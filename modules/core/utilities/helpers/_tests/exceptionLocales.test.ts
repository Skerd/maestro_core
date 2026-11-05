import fs from "fs";
import path from "path";
import {describe, expect, it} from "vitest";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {loadModuleExceptionLocales, localeFileNameToLanguageCode} from "../exceptionLocales";

const modulesRoot = path.join(path.dirname(require.resolve("armonia/package.json")), "src", "modules");

describe("loadModuleExceptionLocales", () => {
    it("maps locale file names to language codes", () => {
        expect(localeFileNameToLanguageCode("de_CH.json")).toBe("de-CH");
        expect(localeFileNameToLanguageCode("sq.json")).toBe("sq");
        expect(localeFileNameToLanguageCode("README.md")).toBeNull();
    });

    it("makes every module's messages resolvable, in each of its languages", () => {
        loadModuleExceptionLocales();
        loadModuleExceptionLocales(); // a second call must not register anything twice
        const moduleNames = fs.readdirSync(modulesRoot).filter((name) => name !== "core");
        let checked = 0;
        for (const moduleName of moduleNames) {
            const dir = path.join(modulesRoot, moduleName, "helpers", "static", "exceptions");
            if (!fs.existsSync(dir)) continue;
            for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
                const languageCode = localeFileNameToLanguageCode(file) ?? "";
                const definitions = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<string, {error_code?: string}>;
                for (const [key, definition] of Object.entries(definitions)) {
                    expect(apiValidationException(key, "", null, languageCode).error_code, `${moduleName}/${file} ${key}`)
                        .toBe(definition.error_code);
                    checked++;
                }
            }
        }
        expect(checked).toBeGreaterThan(0);
    });
});

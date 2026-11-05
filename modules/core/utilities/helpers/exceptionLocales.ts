import fs from "fs";
import path from "path";
import {registerLocaleBundle} from "armonia/src/modules/core/helpers/exceptions";
import type {ApiExceptionDefinition} from "armonia/src/modules/core/helpers/exceptions";

/** `en_US.json` → `en-US`, `sq.json` → `sq` */
export function localeFileNameToLanguageCode(filename: string): string | null {
    if (!filename.endsWith(".json")) return null;
    const base = filename.slice(0, -".json".length);
    const idx = base.indexOf("_");
    if (idx === -1) return base;
    return `${base.slice(0, idx).toLowerCase()}-${base.slice(idx + 1).toUpperCase()}`;
}

let loaded = false;

/**
 * Registers every vertical module's API error messages (`armonia/src/modules/<module>/helpers/static/exceptions/*.json`)
 * with armonia's `apiValidationException`. Core's own messages are built into armonia (D37: armonia never reads files).
 * Each server calls this once at start-up and the test setup calls it; later calls do nothing.
 */
export function loadModuleExceptionLocales(): void {
    if (loaded) return;
    loaded = true;
    const modulesRoot = path.join(path.dirname(require.resolve("armonia/package.json")), "src", "modules");
    const moduleNames = fs
        .readdirSync(modulesRoot, {withFileTypes: true})
        .filter((entry) => entry.isDirectory() && entry.name !== "core" && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort();
    for (const moduleName of moduleNames) {
        const dir = path.join(modulesRoot, moduleName, "helpers", "static", "exceptions");
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
            const languageCode = localeFileNameToLanguageCode(file);
            if (!languageCode) continue;
            const fragment = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as ApiExceptionDefinition;
            registerLocaleBundle(languageCode, fragment);
        }
    }
}

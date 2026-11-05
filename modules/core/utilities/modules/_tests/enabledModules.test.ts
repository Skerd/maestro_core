import fs from "fs";
import {describe, expect, it} from "vitest";
import {loadModuleManifest, MODULE_MANIFEST_PATH, resolveModuleSelection} from "../enabledModules";

describe("module manifest in maestro core (D01a)", () => {
    it("is the file beside core and names only known modules as dependencies", () => {
        expect(fs.existsSync(MODULE_MANIFEST_PATH)).toBe(true);
        const manifest = loadModuleManifest();
        expect(manifest.core?.required).toBe(true);
        for (const [name, entry] of Object.entries(manifest)) {
            for (const dependency of entry.dependsOn ?? []) {
                expect(Object.keys(manifest), `${name} depends on ${dependency}`).toContain(dependency);
            }
        }
    });

    it("resolves every module with its dependencies", () => {
        const manifest = loadModuleManifest();
        for (const [name, entry] of Object.entries(manifest)) {
            expect(resolveModuleSelection([name], manifest)).toEqual(expect.arrayContaining(["core", name, ...(entry.dependsOn ?? [])]));
        }
    });
});

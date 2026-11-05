/**
 * Module selection for deploy-time and runtime filtering.
 *
 * - `ENABLED_MODULES` (comma-separated) limits which modules load at runtime.
 * - When unset, every module folder present under `maestro/modules/` is enabled.
 * - `core` is always included.
 */

import fs from "fs";
import path from "path";

export type ModuleManifestEntry = {
    required?: boolean;
    dependsOn?: string[];
    description?: string;
    sinfoniaOnly?: boolean;
};

export type ModuleManifest = Record<string, ModuleManifestEntry>;

let cachedManifest: ModuleManifest | undefined;

/**
 * The platform's one module manifest (D01a): `maestro/modules/core/modules.manifest.json`, versioned with core.
 * Sinfonia's build and the root governance checks read the same file.
 */
export const MODULE_MANIFEST_PATH = path.resolve(__dirname, "../../modules.manifest.json");

export function loadModuleManifest(): ModuleManifest {
    if (cachedManifest) {
        return cachedManifest;
    }
    const raw = fs.readFileSync(MODULE_MANIFEST_PATH, "utf-8");
    cachedManifest = JSON.parse(raw) as ModuleManifest;
    return cachedManifest;
}

function discoverPresentModuleNames(modulesRoot = path.resolve(__dirname, "../../..")): string[] {
    if (!fs.existsSync(modulesRoot)) {
        return ["core"];
    }
    return fs
        .readdirSync(modulesRoot, {withFileTypes: true})
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort();
}

/**
 * Resolve module list with dependency closure. Unknown names throw.
 */
export function resolveModuleSelection(requested: string[], manifest?: ModuleManifest): string[] {
    let m: ModuleManifest;
    try {
        m = manifest ?? loadModuleManifest();
    } catch {
        if (process.env.ENABLED_MODULES?.trim()) {
            return [...new Set(["core", ...requested.filter((name) => name !== "core")])].sort();
        }
        throw new Error("Module manifest not found and ENABLED_MODULES is unset");
    }
    const resolved = new Set<string>(["core"]);
    const queue = [...requested.filter((name) => name !== "core")];

    while (queue.length > 0) {
        const name = queue.shift()!;
        if (resolved.has(name)) {
            continue;
        }
        const entry = m[name];
        if (!entry) {
            throw new Error(`Unknown module "${name}". Known modules: ${Object.keys(m).join(", ")}`);
        }
        for (const dep of entry.dependsOn ?? []) {
            if (!resolved.has(dep)) {
                queue.push(dep);
            }
        }
        resolved.add(name);
    }

    return [...resolved].sort();
}

let cachedEnabledModules: string[] | undefined;

/**
 * Enabled module folder names under `maestro/modules/`.
 */
export function getEnabledModuleNames(): string[] {
    if (cachedEnabledModules) {
        return cachedEnabledModules;
    }

    const raw = process.env.ENABLED_MODULES?.trim();
    if (!raw) {
        cachedEnabledModules = discoverPresentModuleNames();
        return cachedEnabledModules;
    }

    const requested = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    cachedEnabledModules = resolveModuleSelection(requested);
    return cachedEnabledModules;
}

export function isModuleEnabled(moduleName: string): boolean {
    return getEnabledModuleNames().includes(moduleName);
}

export function resetEnabledModulesCache(): void {
    cachedEnabledModules = undefined;
}

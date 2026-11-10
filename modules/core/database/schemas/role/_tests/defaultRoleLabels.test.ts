import fs from "fs";
import path from "path";
import {describe, expect, it} from "vitest";
import type {DefaultRoleDefinition} from "@coreModule/database/schemas/role/role.defaults";

/**
 * The panel translates a default role only while its stored name equals the en-US label (D118), so the en-US labels in
 * sinfonia must be the maestro definitions word for word (TD-B173). Every module's role pack is found the way the
 * modules are, by folder; the deploy images build maestro without sinfonia, so there the check has nothing to compare.
 */
const modulesRoot = path.resolve(__dirname, "../../../../..");
const sinfoniaModules = path.resolve(modulesRoot, "../../sinfonia/src/modules");

function isDefinitionList(value: unknown): value is DefaultRoleDefinition[] {
    return Array.isArray(value) && value.every((role) => typeof role === "object" && role !== null && "slug" in role && "name" in role);
}

async function maestroDefinitions(): Promise<DefaultRoleDefinition[]> {
    const definitions: DefaultRoleDefinition[] = [];
    for (const moduleName of fs.readdirSync(modulesRoot)) {
        const roleDir = path.join(modulesRoot, moduleName, "database", "schemas", "role");
        if (!fs.existsSync(roleDir)) continue;
        for (const file of fs.readdirSync(roleDir).filter((name) => name.endsWith("role.defaults.ts"))) {
            const exports: Record<string, unknown> = await import(path.join(roleDir, file));
            for (const value of Object.values(exports)) {
                if (isDefinitionList(value)) definitions.push(...value);
            }
        }
    }
    return definitions;
}

type RoleLabel = {name?: string; description?: string};

function sinfoniaLabels(): Map<string, RoleLabel> {
    const labels = new Map<string, RoleLabel>();
    for (const moduleName of fs.readdirSync(sinfoniaModules)) {
        const file = path.join(sinfoniaModules, moduleName, "assets", "languages", "en-US", "rolesPermissions.json");
        if (!fs.existsSync(file)) continue;
        const roles = (JSON.parse(fs.readFileSync(file, "utf8")) as {roles?: Record<string, RoleLabel>}).roles ?? {};
        for (const [slug, label] of Object.entries(roles)) labels.set(slug, label);
    }
    return labels;
}

describe.skipIf(!fs.existsSync(sinfoniaModules))("default role labels (D118)", () => {
    it("labels every default role in en-US with its maestro name and description", async () => {
        const definitions = await maestroDefinitions();
        const labels = sinfoniaLabels();
        expect(definitions.length).toBeGreaterThan(0);
        for (const role of definitions) {
            const label = labels.get(role.slug);
            expect(label, `sinfonia en-US rolesPermissions.json roles.${role.slug}`).toBeDefined();
            expect(label?.name, `roles.${role.slug}.name`).toBe(role.name);
            expect(label?.description, `roles.${role.slug}.description`).toBe(role.description);
        }
    });
});

// Second half of `npm run build` (D106): `tsc -p tsconfig.build.json` emits maestro and armonia JavaScript into
// maestro/dist; this copies every non-TypeScript file the runtime reads beside it (locale and exception JSON, email
// templates, seed media, fonts, tsconfig.json for tsconfig-paths, package.json files), so dist/maestro and
// dist/armonia mirror the source layout. Node built-ins only (no new package).
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const maestroRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = path.dirname(maestroRoot);
const armoniaRoot = path.join(workspaceRoot, "armonia");
const distRoot = path.join(maestroRoot, "dist");

// Never runtime input: dependencies, VCS, build output, local state, test-only folders, generated graphs.
const SKIPPED_NAMES = new Set(["node_modules", ".git", "dist", "_temp", "coverage", "graphify-out", "_test", "_tests", ".DS_Store"]);
// Maestro's own local state (logs, secrets), skipped only at its root.
const SKIPPED_MAESTRO_ROOT_DIRS = new Set(["logs", "secrets"].map((name) => path.join(maestroRoot, name)));

function isCopied(source) {
    const name = path.basename(source);
    if (SKIPPED_NAMES.has(name) || SKIPPED_MAESTRO_ROOT_DIRS.has(source)) return false;
    if (name.startsWith(".env") || name.endsWith(".tsbuildinfo")) return false;
    // tsc already emitted the JavaScript for every .ts; declarations (.d.ts) are not runtime code either.
    return !name.endsWith(".ts");
}

function copyTree(from, to) {
    if (!fs.existsSync(from)) throw new Error(`copyRuntimeAssets: missing ${from}`);
    fs.cpSync(from, to, {recursive: true, filter: isCopied});
}

if (!fs.existsSync(path.join(distRoot, "maestro"))) {
    throw new Error("copyRuntimeAssets: run `tsc -p tsconfig.build.json` first (dist/maestro is missing)");
}
// Entry by entry: dist lives inside maestro, and `fs.cpSync` refuses a destination inside its source.
for (const name of fs.readdirSync(maestroRoot)) {
    const source = path.join(maestroRoot, name);
    if (isCopied(source)) copyTree(source, path.join(distRoot, "maestro", name));
}
copyTree(path.join(armoniaRoot, "package.json"), path.join(distRoot, "armonia", "package.json"));
copyTree(path.join(armoniaRoot, "src"), path.join(distRoot, "armonia", "src"));
console.log(`copyRuntimeAssets: runtime assets copied into ${path.relative(process.cwd(), distRoot) || "."}`);

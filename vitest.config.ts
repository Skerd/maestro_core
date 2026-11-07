import path from "node:path";
import {config as loadEnv} from "dotenv";
import {defineConfig} from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Tests must not need a developer's `.env` (a clean checkout or the deploy image has none, D08). The developer's
// file loads first; then the values tests rely on, if still unset; then the tracked `.env.test` template gives every
// other variable the environment module reads at import a value (dotenv never overrides). Workers inherit this env.
loadEnv({path: path.join(__dirname, ".env")});
const TEST_DEFAULTS: Record<string, string> = {
    JWT_SECRET: "vitest-only-not-a-real-secret", // booking manage links are signed
    CLIENT_HOST: "http://localhost:5173", // links in customer messages
    MAX_FILES_UPLOADED: "100", // upload middleware limits
    MAX_FILE_SIZE: "524288000",
};
for (const [name, value] of Object.entries(TEST_DEFAULTS)) if (!process.env[name]) process.env[name] = value;
loadEnv({path: path.join(__dirname, ".env.test")});

// Resolves the tsconfig path aliases (`@coreModule/*`, `@initializer`, …) in tests.
export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        // One in-memory MongoDB replica set for the whole run; each DB-backed file connects to it with
        // `connectTestDatabase` in a database of its own (TD-T14: one replica set per file died mid-file under
        // load). Four files run at once: with one shared replica set and `Model.init()` before each file's first
        // transaction, they no longer contend (TD-B19); more workers mostly queue on the single mongod.
        globalSetup: ["./modules/core/_tests/mongoGlobalSetup.ts"],
        maxWorkers: 4,
        minWorkers: 1,
        hookTimeout: 60_000,
        // The modules' API error messages, which the servers register at start-up.
        setupFiles: ["./modules/core/_tests/vitestSetup.ts"],
    },
});

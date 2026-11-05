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
        // ~26 files each boot their own in-memory MongoDB replica set. Run in parallel they contend for the
        // machine and fail at random (hook timeouts, transactions exhausting their retries); run one file at a
        // time (each still isolated) the suite is deterministic: 778/778 on 2026-11-04, ~3 min.
        fileParallelism: false,
        hookTimeout: 60_000,
        // The modules' API error messages, which the servers register at start-up.
        setupFiles: ["./modules/core/_tests/vitestSetup.ts"],
    },
});

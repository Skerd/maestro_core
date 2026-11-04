import {defineConfig} from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Resolves the tsconfig path aliases (`@coreModule/*`, `@initializer`, …) in tests.
export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        // ~26 files each boot their own in-memory MongoDB replica set. Run in parallel they contend for the
        // machine and fail at random (hook timeouts, transactions exhausting their retries); run one file at a
        // time (each still isolated) the suite is deterministic: 778/778 on 2026-11-04, ~3 min.
        fileParallelism: false,
        hookTimeout: 60_000,
    },
});

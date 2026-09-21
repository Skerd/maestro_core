import {defineConfig} from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Resolves the tsconfig path aliases (`@coreModule/*`, `@initializer`, …) in tests.
export default defineConfig({
    plugins: [tsconfigPaths()],
});

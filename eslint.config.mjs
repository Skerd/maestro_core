import tseslint from "typescript-eslint";

/** Governance rules only (P1, D36/D38); the root `npm run lint` freezes existing findings in a baseline. */
const DATE_LIBRARIES = ["date-fns", "moment", "moment-timezone"].map((name) => ({name, message: "Use dayjs (D36)."}));

export default tseslint.config(
    {ignores: ["node_modules/**", "vendor/**", "dist/**", "scripts/**", "**/*.js", "**/*.cjs", "**/*.mjs"]},
    {
        files: ["**/*.ts"],
        languageOptions: {parser: tseslint.parser},
        linterOptions: {reportUnusedDisableDirectives: "off"},
        // Existing disable comments may name typescript-eslint rules; registering the plugin keeps them valid.
        plugins: {"@typescript-eslint": tseslint.plugin},
        rules: {
            // D38: log through params.logger or getLogger(name).
            "no-console": "error",
            "no-restricted-imports": ["error", {paths: DATE_LIBRARIES, patterns: [{group: ["date-fns/*"], message: "Use dayjs (D36)."}]}],
        },
    },
    {files: ["**/_tests/**", "**/_test/**", "**/*.test.ts"], rules: {"no-console": "off"}},
);

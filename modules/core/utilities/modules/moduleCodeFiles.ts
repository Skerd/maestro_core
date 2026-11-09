/**
 * File-name rules for module discovery (D106). Maestro runs from TypeScript sources under ts-node and vitest, and
 * from compiled JavaScript in production, so the loaders that scan module folders (routes, cron, kafka, rooms,
 * notifications, portal providers, assistant tools, erasers, bootstraps, demo seeds, env validators) never hard-code
 * `.ts`: they match files with the extension of the code that is actually running.
 */

import path from "path";

/** The extension of the running code: `.ts` under ts-node and vitest, `.js` in the compiled build. */
export const MODULE_FILE_EXTENSION = path.extname(__filename);

const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]s$/;

/**
 * Whether a directory entry is loadable module code: it has the running extension and is neither a declaration
 * file nor a test file. Source maps (`.js.map`) and the other extension's files are rejected.
 *
 * @param fileName - the bare file name, as `fs.readdirSync` returns it
 * @param ext - the extension to accept; defaults to {@link MODULE_FILE_EXTENSION} (tests pass both)
 */
export function isModuleCodeFile(fileName: string, ext: string = MODULE_FILE_EXTENSION): boolean {
    return fileName.endsWith(ext) && !fileName.endsWith(".d.ts") && !TEST_FILE_PATTERN.test(fileName);
}

/**
 * The file name of a well-known module file (`moduleBootstrap`, `companyDemoSeed`, …) for the running code.
 *
 * @param base - the file name without extension
 * @param ext - defaults to {@link MODULE_FILE_EXTENSION}
 */
export function moduleCodeFile(base: string, ext: string = MODULE_FILE_EXTENSION): string {
    return `${base}${ext}`;
}

/**
 * Strips the running extension from a path, giving the specifier `import()` / `require()` resolve under either
 * runtime. A path without that extension is returned unchanged.
 *
 * @param filePath - a file path or a relative route path
 * @param ext - defaults to {@link MODULE_FILE_EXTENSION}
 */
export function withoutModuleExtension(filePath: string, ext: string = MODULE_FILE_EXTENSION): string {
    return filePath.endsWith(ext) ? filePath.slice(0, -ext.length) : filePath;
}

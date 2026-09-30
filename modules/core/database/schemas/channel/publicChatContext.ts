import type {PopulateOptions} from "mongoose";

let contextTag: string | undefined;
const populatePaths: PopulateOptions[] = [];
let registered = false;

/**
 * Feature modules register how their own public-chat ObjectIds should be
 * populated (paths and models they own). Core stores those ids without
 * mongoose `ref` and without naming the keys.
 */
export function registerPublicChatContext(options: {
    tag: string;
    populate?: PopulateOptions[];
}): void {
    if (registered) {
        return;
    }
    registered = true;
    contextTag = options.tag;
    if (options.populate) {
        populatePaths.push(...options.populate);
    }
}

export function getPublicChatContextTag(): string | undefined {
    return contextTag;
}

export function getPublicChatPopulate(): PopulateOptions[] {
    return populatePaths;
}

/** Merge feature public-chat populate onto SchemaGuard's populate result. */
export function withPublicChatPopulate(populate: {select?: string; populate?: unknown}): {select?: string; populate?: unknown} {
    if (populatePaths.length === 0) {
        return populate;
    }
    const existing = populate.populate;
    const existingArr = existing == null ? [] : Array.isArray(existing) ? existing : [existing];
    const merged = [...existingArr, ...populatePaths];
    return {
        ...populate,
        populate: merged.length === 1 ? merged[0] : merged,
    };
}

/** Test helper — not used at runtime. */
export function resetPublicChatContextForTests(): void {
    contextTag = undefined;
    populatePaths.length = 0;
    registered = false;
}

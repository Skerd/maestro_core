/**
 * General Helper Utilities
 * 
 * Simple, reusable helper functions used across the application.
 */

/**
 * Generate a random string of specified length
 */
export function generateRandomString(length: number): string {
    const charset = "MdgvJe1soP4jGFwzy5XQRDmHILN8huAiSn7BxUTrlWECtKZafcb2Vq03kOYp96";
    let randomString = "";
    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * charset.length);
        randomString += charset.charAt(randomIndex);
    }
    return randomString;
}

/**
 * Get first day of current month
 */
export function firstOfMonth(): Date {
    const today = new Date();
    today.setDate(1);
    today.setHours(0, 0, 0, 0);
    return today;
}

/**
 * Get last day of current month
 */
export function lastOfMonth(): Date {
    const today = new Date();
    today.setMonth(today.getMonth() + 1, 0);
    today.setHours(0, 0, 0, 0);
    return today;
}

/**
 * Check if value is a plain object (not array, not null)
 */
export function isPlainObject(v: any): v is Record<string, any> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Escapes special regex characters in a string for safe use in MongoDB `$regex`.
 * Prevents regex injection and ensures the search term is matched literally (aside from case).
 *
 * @param str - User-provided search string.
 * @returns String safe to use in a `$regex` pattern.
 */
export function escapeRegex(str: string): string {
    return str.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
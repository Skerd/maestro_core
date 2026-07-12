/**
 * Websocket room display-name registry.
 *
 * Core and feature modules register friendly names for site / system rooms at
 * boot (see {@link module:registerAllRoomContributions}). The WS layer reads
 * names for dashboards and hydration; modules never get imported statically.
 *
 * @module roomRegistry
 */

const displayNames = new Map<string, string>();

/**
 * Register one or more room id → display name mappings.
 * Later registrations overwrite earlier ones for the same id.
 */
export function registerRoomDisplayNames(names: Record<string, string>): void {
    for (const [id, name] of Object.entries(names)) {
        if (!id || !name) continue;
        displayNames.set(id, name);
    }
}

/**
 * Turn a room id into a readable label when no contribution registered it.
 * `modificationRequests` → `Modification requests`, `listing_flags` → `Listing flags`.
 */
export function humanizeRoomId(roomId: string): string {
    const spaced = roomId
        .replace(/[_-]+/g, " ")
        .replace(/([a-z\d])([A-Z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim();
    if (!spaced) return roomId;
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Friendly label for a room id (registered name, else humanized id). */
export function getRoomDisplayName(roomId: string): string {
    return displayNames.get(roomId) ?? humanizeRoomId(roomId);
}

/** All room ids that have an explicit display name (known at hydration time). */
export function getKnownRoomIds(): string[] {
    return [...displayNames.keys()];
}

export function getRegisteredRoomCount(): number {
    return displayNames.size;
}

/** Tests only. */
export function clearRoomDisplayNames(): void {
    displayNames.clear();
}

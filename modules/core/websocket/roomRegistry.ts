/**
 * Websocket room registry: display names, and the room families the server broadcasts to (D172).
 *
 * Core and feature modules register friendly names for site / system rooms and their broadcast rooms at
 * boot (see {@link module:registerAllRoomContributions}). The WS layer reads them for dashboards, hydration,
 * joins and broadcasts; modules never get imported statically.
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

/**
 * A family of rooms the server broadcasts to (D172), registered by a module at boot: the room `name`, or
 * `name_<suffix>` (one room per record, e.g. `liveTask_<id>`). Every other room is presence only. `canJoin` decides
 * each join; it sees only who the connection is, and fails closed when it throws.
 */
export type BroadcastRoomRule = {
    /** Letters and digits only: `_` separates the family from a room's own suffix. */
    name: string;
    canJoin: (member: {userId: string; companyId: string}) => boolean | Promise<boolean>;
};

const broadcastRooms = new Map<string, BroadcastRoomRule>();

/** Registers a broadcast room family; a later registration of the same name replaces it. */
export function registerBroadcastRooms(rule: BroadcastRoomRule): void {
    broadcastRooms.set(rule.name, rule);
}

/** The broadcast family a room belongs to, or none for a presence room. */
export function broadcastRoomRule(room: string): BroadcastRoomRule | undefined {
    return broadcastRooms.get(room) ?? broadcastRooms.get(room.split("_")[0]);
}

/** Tests only. */
export function clearBroadcastRooms(): void {
    broadcastRooms.clear();
}

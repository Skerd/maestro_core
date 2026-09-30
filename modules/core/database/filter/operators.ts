/**
 * Operator handlers that map filter rules to MongoDB query conditions.
 *
 * Lives in Maestro (not Armonia): handlers construct driver `ObjectId` values and must
 * use this package's `mongodb` major (currently 4, pinned by Mongoose 6). Armonia keeps
 * the Filter DSL types and operator allowlists only — see
 * `armonia/src/modules/core/database/filter/`.
 *
 * All handlers are pure functions; no DB or I/O.
 */

import {ObjectId} from "mongodb";
import type {FilterOperator, FilterValue} from "armonia/src/modules/core/database/filter/filter.types";
import type {FilterFieldConfig} from "armonia/src/modules/core/database/filter/fieldRegistry.types";
import {
    COLUMN_TYPE,
    isDateColumnType,
    isNumberColumnType,
    isPresenceColumnType,
    isStringColumnType,
} from "armonia/src/modules/core/database/filter/typeOperators";

/** Escapes special regex characters for safe $regex use. Inlined to avoid cross-package deps. */
function escapeRegex(str: string): string {
    return str.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function coerceObjectId(v: unknown): ObjectId | null {
    if (v == null) return null;
    if (v instanceof ObjectId) return v;
    if (typeof v === "string") {
        try {
            return new ObjectId(v);
        } catch {
            return null;
        }
    }
    return null;
}

function coerceObjectIdArray(v: unknown): ObjectId[] {
    if (!Array.isArray(v)) return [];
    return v.map(coerceObjectId).filter((id): id is ObjectId => id != null);
}

function coerceDate(v: unknown): Date | null {
    if (v == null) return null;
    if (v instanceof Date) return v;
    if (typeof v === "string" || typeof v === "number") {
        const d = new Date(v);
        return isNaN(d.getTime()) ? null : d;
    }
    return null;
}

function coerceRangeBound(value: unknown, type: COLUMN_TYPE): Date | number | null {
    if (isDateColumnType(type)) return coerceDate(value);
    if (isNumberColumnType(type)) return typeof value === "number" ? value : null;
    return null;
}

/**
 * String-list "exists" means at least one element. `$exists` alone is wrong for
 * `default: []` — the path is always present.
 */
function arrayPresenceQuery(field: string, present: boolean): Record<string, unknown> {
    return {[`${field}.0`]: {$exists: present}};
}

/**
 * File / avatar "exists" means an attachment is present: a scalar ObjectId, or an
 * array with at least one element. `$exists` alone is wrong for `default: []`.
 */
function mediaPresenceQuery(field: string, present: boolean): Record<string, unknown> {
    const hasAttachment = {
        $or: [
            {[field]: {$type: "objectId"}},
            {[`${field}.0`]: {$exists: true}},
        ],
    };
    return present ? hasAttachment : {$nor: [hasAttachment]};
}

export type OperatorHandler = (
    field: string,
    value: FilterValue,
    config: FilterFieldConfig
) => Record<string, unknown> | null;

const OPERATOR_HANDLERS: Record<FilterOperator, OperatorHandler> = {
    equals(field, value, config) {
        if (config.type === "objectId") {
            const id = coerceObjectId(value);
            if (id === null && value !== null && value !== undefined) return null;
            return {[field]: id ?? value};
        }
        if (isDateColumnType(config.type)) {
            const d = coerceDate(value);
            return d != null ? {[field]: d} : {[field]: value};
        }
        return {[field]: value};
    },

    notEquals(field, value, config) {
        if (config.type === "objectId") {
            const id = coerceObjectId(value);
            if (id === null && value !== null && value !== undefined) return null;
            return {[field]: {$ne: id ?? value}};
        }
        if (isDateColumnType(config.type)) {
            const d = coerceDate(value);
            return d != null ? {[field]: {$ne: d}} : {[field]: {$ne: value}};
        }
        return {[field]: {$ne: value}};
    },

    contains(field, value, config) {
        if (!isStringColumnType(config.type) || typeof value !== "string") return null;
        const escaped = escapeRegex(value);
        return {[field]: {$regex: escaped, $options: "i"}};
    },

    startsWith(field, value, config) {
        if (!isStringColumnType(config.type) || typeof value !== "string") return null;
        const escaped = escapeRegex(value);
        return {[field]: {$regex: `^${escaped}`, $options: "i"}};
    },

    endsWith(field, value, config) {
        if (!isStringColumnType(config.type) || typeof value !== "string") return null;
        const escaped = escapeRegex(value);
        return {[field]: {$regex: `${escaped}$`, $options: "i"}};
    },

    greaterThan(field, value, config) {
        const v = coerceRangeBound(value, config.type);
        if (v == null) return null;
        return {[field]: {$gt: v}};
    },

    greaterThanOrEqual(field, value, config) {
        const v = coerceRangeBound(value, config.type);
        if (v == null) return null;
        return {[field]: {$gte: v}};
    },

    lessThan(field, value, config) {
        const v = coerceRangeBound(value, config.type);
        if (v == null) return null;
        return {[field]: {$lt: v}};
    },

    lessThanOrEqual(field, value, config) {
        const v = coerceRangeBound(value, config.type);
        if (v == null) return null;
        return {[field]: {$lte: v}};
    },

    between(field, value, config) {
        const tuple = Array.isArray(value) && value.length === 2 ? value : null;
        if (!tuple) return null;
        const min = coerceRangeBound(tuple[0], config.type);
        const max = coerceRangeBound(tuple[1], config.type);
        if (min == null || max == null) return null;
        return {[field]: {$gte: min, $lte: max}};
    },

    in(field, value, config) {
        if (!Array.isArray(value)) return null;
        if (config.type === "objectId") {
            const ids = coerceObjectIdArray(value);
            if (ids.length === 0) return null;
            return {[field]: {$in: ids}};
        }
        if (isDateColumnType(config.type)) {
            const dates = value.map(coerceDate).filter((d): d is Date => d != null);
            if (dates.length === 0) return null;
            return {[field]: {$in: dates}};
        }
        return {[field]: {$in: value}};
    },

    notIn(field, value, config) {
        if (!Array.isArray(value)) return null;
        if (config.type === "objectId") {
            const ids = coerceObjectIdArray(value);
            if (ids.length === 0) return null;
            return {[field]: {$nin: ids}};
        }
        if (isDateColumnType(config.type)) {
            const dates = value.map(coerceDate).filter((d): d is Date => d != null);
            if (dates.length === 0) return null;
            return {[field]: {$nin: dates}};
        }
        return {[field]: {$nin: value}};
    },

    exists(field, value, config) {
        if (typeof value !== "boolean") return null;
        if (isPresenceColumnType(config.type)) {
            return mediaPresenceQuery(field, value);
        }
        if (config.type === COLUMN_TYPE.ARRAY) {
            return arrayPresenceQuery(field, value);
        }
        return {[field]: {$exists: value}};
    },
};

export {OPERATOR_HANDLERS};

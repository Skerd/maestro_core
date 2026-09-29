/**
 * Common mapper utilities shared by Core and feature-module DTO mappers.
 */

import {Decimal128, ObjectId} from 'mongodb';
import type {SimpleUser} from "armonia/src/modules/core/dto/user.dto";
import type {CompanyBlank} from "armonia/src/modules/core/dto/company.dto";
import type {CurrencySimple} from "armonia/src/modules/core/dto/currency.dto";
import {IUser} from "@coreModule/database/schemas/user/user";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {ICurrency} from "@coreModule/database/schemas/currency/currency";

/**
 * Converts ObjectId to string safely
 *
 * @param id - ObjectId, string, or undefined
 * @returns String representation of ID, or empty string if undefined
 *
 * @example
 * ```typescript
 * const id = objectIdToString(user._id); // "507f1f77bcf86cd799439011"
 * ```
 */
export function objectIdToString(id: ObjectId | string | undefined | null): string {
    if (!id) return '';
    if (typeof id === 'string') return id;
    return id.toString();
}

/**
 * Converts optional BSON Decimal128 (or a number) to a JavaScript number for JSON DTOs.
 */
export function decimalToNumber(v: Decimal128 | unknown): number | undefined {
    if (v == null) return undefined;
    if (typeof v === "object" && v !== null && "toString" in v) {
        return parseFloat((v as {toString: () => string}).toString());
    }
    if (typeof v === "number") return v;
    return parseFloat(String(v));
}

/**
 * Safely maps a date to ISO string
 *
 * @param date - Date object, string, or null/undefined
 * @returns ISO string or empty string
 *
 * @example
 * ```typescript
 * const dateStr = dateToISOString(user.createdAt);
 * ```
 */
export function dateToISOString(date: Date | string | null | undefined): string {
    if (!date) return '';
    if (typeof date === 'string') return date;
    return date.toISOString();
}

function objectIdHex(value: unknown): string | undefined {
    if (value == null) return undefined;
    if (typeof value === "string") {
        const hex = value.trim();
        return /^[a-fA-F0-9]{24}$/.test(hex) ? hex : undefined;
    }
    if (typeof value === "object" && value !== null && "_id" in value) {
        const nested = (value as {_id?: unknown})._id;
        if (nested != null && nested !== value) return objectIdHex(nested);
    }
    if (typeof value === "object" && value !== null && typeof (value as {toString?: () => string}).toString === "function") {
        const hex = String(value);
        return /^[a-fA-F0-9]{24}$/.test(hex) ? hex : undefined;
    }
    return undefined;
}

export function mapMedia(media: any) {
    const id = objectIdHex(media?._id) ?? objectIdHex(media);
    if (!id) return undefined;
    return {
        _id: id,
        name: media?.fileName,
        size: media?.metadata?.size || 0,
        extension: media?.metadata?.extension || media?.extension,
        mime: media?.metadata?.mime || media?.mimeType,
        safeCheckedFlag: media?.metadata?.safeCheckedFlag || false,
        resolution: media?.resolution || undefined
    };
}

function isSnippetBranch(spec: unknown): spec is {readonly keys: Readonly<Record<string, unknown>>} {
    if (typeof spec !== "object" || spec === null || !("keys" in spec)) return false;
    const keys = (spec as {keys?: unknown}).keys;
    return typeof keys === "object" && keys !== null;
}

function isRawObjectId(value: object): boolean {
    if (value instanceof ObjectId) return true;
    if ("_id" in value) return false;
    return /^[a-fA-F0-9]{24}$/.test(String(value));
}

function isDecimal128(value: object): boolean {
    return value instanceof Decimal128 || (value as {_bsontype?: string})._bsontype === "Decimal128";
}

function mapSnippetLeaf(value: unknown): unknown {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
    if (typeof value !== "object" || value === null) return undefined;
    if (isDecimal128(value)) return decimalToNumber(value);
    if (isRawObjectId(value)) return objectIdHex(value);
    return value;
}

function projectSnippet(
    doc: object,
    snippet: {readonly keys: Readonly<Record<string, unknown>>},
): Record<string, unknown> | undefined {
    const keys = snippet.keys;
    if (isRawObjectId(doc)) {
        if (!("_id" in keys)) return undefined;
        const id = objectIdHex(doc);
        return id ? {_id: id} : undefined;
    }

    const source = doc as Record<string, unknown>;
    if ("_id" in keys) {
        const id = objectIdHex(source._id);
        if (!id) return undefined;
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(keys)) {
        const mapped = mapSnippetValue(source[key], keys[key], key === "_id");
        if (mapped !== undefined) out[key] = mapped;
    }
    return out;
}

function mapSnippetValue(value: unknown, spec: unknown, isIdKey: boolean): unknown {
    if (value == null) return undefined;
    if (isIdKey) return objectIdHex(value);
    if (Array.isArray(value)) {
        const items = value
            .map((item) => mapSnippetValue(item, spec, false))
            .filter((item) => item !== undefined);
        return items;
    }
    if (isSnippetBranch(spec)) {
        if (typeof value !== "object") return undefined;
        return projectSnippet(value, spec);
    }
    return mapSnippetLeaf(value);
}

/**
 * Projects a document onto a snippet allowlist into an Armonia wire type.
 * A `{ keys }` value is projected again, and an array is projected per element.
 * A leaf ObjectId becomes a hex string. `_id` is required only when the snippet lists it.
 * The assertion holds when callers pass the matching Armonia wire type as the
 * second type argument to `defineSnippet<IEntity, WireType>()`.
 */
export function mapSnippet<Wire extends object>() {
    return <S extends { readonly keys: Readonly<Record<string, unknown>> }>(
        doc: object | null | undefined,
        snippet: S,
    ): Wire | undefined => {
        if (doc == null) return undefined;
        const projected = projectSnippet(doc, snippet);
        return projected as Wire | undefined;
    };
}

export function mapPopulatedRef(ref: any): { _id: string; name: string } | undefined {
    if (!ref) return undefined;
    const id = objectIdHex(ref._id) ?? objectIdHex(ref);
    if (!id) return undefined;
    return {
        _id: id,
        name: typeof ref.name === "string" ? ref.name : "",
    };
}

export function mapPopulatedSimpleUser(ref: IUser): SimpleUser | undefined {
    if (!ref) return undefined;
    const id = objectIdHex(ref._id) ?? objectIdHex(ref);
    if (!id) return undefined;
    return {
        _id: id,
        name: ref.name,
        surname: ref.surname,
    };
}

export function mapPopulatedUserWithPhoto(user: unknown): SimpleUser | undefined {
    if (!user || typeof user !== "object" || !("_id" in user)) {
        return undefined;
    }
    const u = user as IUser;
    const photoRef = u.photo as {_id?: unknown} | string | null | undefined;
    let photo: string | undefined;
    if (photoRef != null) {
        if (typeof photoRef === "object" && photoRef._id != null) {
            photo = String(photoRef._id);
        } else {
            photo = String(photoRef);
        }
    }
    const id = objectIdHex(u._id);
    if (!id) return undefined;
    return {
        _id: id,
        name: u.name,
        surname: u.surname,
        photo,
    };
}

export function mapPopulatedSimpleCompany(ref: ICompany): CompanyBlank | undefined {
    if (!ref) return undefined;
    const id = objectIdHex(ref._id) ?? objectIdHex(ref);
    if (!id) return undefined;
    return {
        _id: id,
        name: ref.name,
        vat: ref.vat,
    };
}

export function mapPopulatedSimpleCurrency(ref: ICurrency): CurrencySimple | undefined {
    if (!ref) return undefined;
    const id = objectIdHex(ref._id) ?? objectIdHex(ref);
    if (!id) return undefined;
    return {
        _id: id,
        name: ref.name,
        symbol: ref.symbol,
        abbreviation: ref.abbreviation,
    };
}

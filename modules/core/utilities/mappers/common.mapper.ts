/**
 * Common mapper utilities shared by Core and feature-module DTO mappers.
 */

import {ObjectId} from 'mongodb';
import {MessageSenderType} from "armonia/src/modules/core/api/user/private/chats/messages/messages.form.response.type";
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
 * Converts optional BSON Decimal128 (or legacy numeric fields read as number) to a JavaScript number for JSON DTOs.
 */
export function decimal128ToNumber(value: unknown): number | undefined {
    if (value == null) {
        return undefined;
    }
    if (typeof value === 'number' && !Number.isNaN(value)) {
        return value;
    }
    if (typeof value === 'object' && typeof (value as {toString?: () => string}).toString === 'function') {
        const n = parseFloat((value as {toString: () => string}).toString());
        return Number.isNaN(n) ? undefined : n;
    }
    return undefined;
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

export function decimalToNumber(v: unknown): number | undefined {
    if (v == null) return undefined;
    if (typeof v === "object" && v !== null && "toString" in v) {
        return parseFloat((v as {toString: () => string}).toString());
    }
    if (typeof v === "number") return v;
    return parseFloat(String(v));
}

export function mapMedia(media: any) {
    return {
        _id: media._id.toString(),
        name: media.fileName,
        size: media.metadata?.size || 0,
        extension: media.metadata?.extension || media.extension,
        mime: media.metadata?.mime || media.mimeType,
        safeCheckedFlag: media.metadata?.safeCheckedFlag || false,
        resolution: media?.resolution || undefined
    };
}

export function mapPopulatedRef(ref: any): { _id: string; name: string } | undefined {
    if( !ref ) return undefined;
    return {
        _id: ref._id?.toString() ?? undefined,
        name: ref.name
    };
}

export function mapPopulatedSimpleUser(ref: IUser): {_id: string, name: string, surname: string} | undefined {
    if( !ref ) return undefined;
    return {
        _id: ref._id?.toString() ?? undefined,
        name: ref.name,
        surname: ref.surname,
    };
}

export function mapPopulatedUserWithPhoto(user: unknown): MessageSenderType | undefined {
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
    return {
        _id: u._id.toString(),
        name: u.name,
        surname: u.surname,
        photo,
    };
}

export function mapPopulatedSimpleCompany(ref: ICompany): {_id: string, name: string, vat: string} | undefined {
    if( !ref ) return undefined;
    return {
        _id: ref._id?.toString() ?? undefined,
        name: ref.name,
        vat: ref.vat,
    };
}

export function mapPopulatedSimpleCurrency(ref: ICurrency): {_id: string, name: string, symbol: string, abbreviation: string} | undefined {
    if( !ref ) return undefined;
    return {
        _id: ref._id?.toString() ?? undefined,
        name: ref.name,
        symbol: ref.symbol,
        abbreviation: ref.abbreviation,
    };
}

/**
 * Common mapper utilities shared by Core and feature-module DTO mappers.
 */

import {Decimal128, ObjectId} from 'mongodb';
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

export function mapPopulatedRef(ref: any): { _id: string; name: string } | undefined {
    if (!ref) return undefined;
    const id = objectIdHex(ref._id) ?? objectIdHex(ref);
    if (!id) return undefined;
    return {
        _id: id,
        name: typeof ref.name === "string" ? ref.name : "",
    };
}

export function mapPopulatedSimpleUser(ref: IUser): {_id: string, name: string, surname: string} | undefined {
    if (!ref) return undefined;
    const id = objectIdHex(ref._id) ?? objectIdHex(ref);
    if (!id) return undefined;
    return {
        _id: id,
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
    const id = objectIdHex(u._id);
    if (!id) return undefined;
    return {
        _id: id,
        name: u.name,
        surname: u.surname,
        photo,
    };
}

export function mapPopulatedSimpleCompany(ref: ICompany): {_id: string, name: string, vat: string} | undefined {
    if (!ref) return undefined;
    const id = objectIdHex(ref._id) ?? objectIdHex(ref);
    if (!id) return undefined;
    return {
        _id: id,
        name: ref.name,
        vat: ref.vat,
    };
}

export function mapPopulatedSimpleCurrency(ref: ICurrency): {_id: string, name: string, symbol: string, abbreviation: string} | undefined {
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

/**
 * Common Mapper Utilities
 * 
 * Reusable functions for common mapping patterns with null safety and validation.
 * Use these to avoid code duplication across mappers and ensure type safety.
 */

import {ObjectId} from 'mongodb';
import type {ApiSelectDatum} from 'armonia/src/modules/core/types/shared.types';
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
 * Maps a simple entity to select dropdown option
 * 
 * @param entity - Entity with _id and name/label field
 * @param labelField - Field to use as label (default: 'name')
 * @returns Select option
 * 
 * @example
 * ```typescript
 * const option = entityToSelect(company, 'name');
 * // { value: "507f...", label: "Company Name" }
 * ```
 */
export function entityToSelect<T extends { _id: ObjectId | string; [key: string]: any }>(
    entity: T,
    labelField: keyof T = 'name'
): ApiSelectDatum {
    return {
        value: objectIdToString(entity._id),
        label: String(entity[labelField] || '')
    };
}

/**
 * Maps an array of entities to select options
 * 
 * @param entities - Array of entities
 * @param labelField - Field to use as label (default: 'name')
 * @returns Array of select options
 * 
 * @example
 * ```typescript
 * const options = entitiesToSelect(companies, 'name');
 * ```
 */
export function entitiesToSelect<T extends { _id: ObjectId | string; [key: string]: any }>(
    entities: T[],
    labelField: keyof T = 'name'
): ApiSelectDatum[] {
    return entities.map(entity => entityToSelect(entity, labelField));
}

/**
 * Maps nested entity to simple reference with ID only
 * 
 * @param entity - Nested entity or null/undefined
 * @returns Reference object with _id, or null
 * 
 * @example
 * ```typescript
 * const ref = nestedEntityToRef(address.city);
 * // { _id: "507f..." } or null
 * ```
 */
export function nestedEntityToRef<T extends { _id: ObjectId | string }>(
    entity: T | null | undefined
): { _id: string } | null {
    if (!entity) return null;
    return {
        _id: objectIdToString(entity._id)
    };
}

/**
 * Maps nested entity to reference with ID and name
 * 
 * @param entity - Nested entity with _id and name, or null/undefined
 * @returns Reference object with _id and name, or null
 * 
 * @example
 * ```typescript
 * const ref = nestedEntityToRefWithName(address.city);
 * // { _id: "507f...", name: "City Name" } or null
 * ```
 */
export function nestedEntityToRefWithName<T extends { _id: ObjectId | string; name: string }>(
    entity: T | null | undefined
): { _id: string; name: string } | null {
    if (!entity) return null;
    return {
        _id: objectIdToString(entity._id),
        name: entity.name
    };
}

/**
 * Maps nested entity to full reference object
 * 
 * @param entity - Nested entity, or null/undefined
 * @param mapper - Optional mapper function to transform entity
 * @returns Mapped entity or null
 * 
 * @example
 * ```typescript
 * const ref = nestedEntityToFull(address.city, (city) => ({
 *     _id: city._id.toString(),
 *     name: city.name,
 *     code: city.code
 * }));
 * ```
 */
export function nestedEntityToFull<TEntity, TRef>(
    entity: TEntity | null | undefined,
    mapper: (entity: TEntity) => TRef
): TRef | null {
    if (!entity) return null;
    return mapper(entity);
}

/**
 * Maps an array of nested entities
 * 
 * @param entities - Array of entities or null/undefined
 * @param mapper - Mapper function to transform each entity
 * @returns Array of mapped entities, or empty array
 * 
 * @example
 * ```typescript
 * const addresses = nestedEntitiesToArray(
 *     company.addresses,
 *     (addr) => addressToDTO(addr)
 * );
 * ```
 */
export function nestedEntitiesToArray<TEntity, TRef>(
    entities: TEntity[] | null | undefined,
    mapper: (entity: TEntity) => TRef
): TRef[] {
    if (!entities || !Array.isArray(entities)) return [];
    return entities.map(mapper);
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

/**
 * Safely maps a date to timestamp
 * 
 * @param date - Date object, string, or null/undefined
 * @returns Timestamp number or 0
 * 
 * @example
 * ```typescript
 * const timestamp = dateToTimestamp(user.createdAt);
 * ```
 */
export function dateToTimestamp(date: Date | string | null | undefined): number {
    if (!date) return 0;
    if (typeof date === 'string') return new Date(date).getTime();
    return date.getTime();
}

/**
 * Safely maps a value with null/undefined handling
 * 
 * @param source - Source value that may be null/undefined
 * @param mapper - Mapper function to transform the value
 * @param defaultValue - Default value if source is null/undefined
 * @returns Mapped value or default
 * 
 * @example
 * ```typescript
 * const name = safeMap(user.name, (n) => n.toUpperCase(), 'Unknown');
 * ```
 */
export function safeMap<T, R>(
    source: T | null | undefined,
    mapper: (item: T) => R,
    defaultValue?: R
): R | null {
    if (source === null || source === undefined) {
        return defaultValue !== undefined ? defaultValue : null;
    }
    try {
        return mapper(source);
    } catch (error) {
        return defaultValue !== undefined ? defaultValue : null;
    }
}

/**
 * Safely maps an array with null/undefined handling
 * 
 * @param source - Source array that may be null/undefined
 * @param mapper - Mapper function to transform each item
 * @returns Array of mapped values, or empty array
 * 
 * @example
 * ```typescript
 * const addresses = safeMapArray(company.addresses, (addr) => addressToDTO(addr));
 * ```
 */
export function safeMapArray<T, R>(
    source: T[] | null | undefined,
    mapper: (item: T) => R
): R[] {
    if (!source || !Array.isArray(source)) return [];
    return source.map(mapper).filter((item): item is R => item !== null && item !== undefined);
}

/**
 * Safely gets a nested property with null/undefined handling
 * 
 * @param source - Source object
 * @param getter - Function to get the nested property
 * @param defaultValue - Default value if property is null/undefined
 * @returns Property value or default
 * 
 * @example
 * ```typescript
 * const cityName = safeGet(address, (a) => a.city?.name, 'Unknown City');
 * ```
 */
export function safeGet<T, R>(
    source: T | null | undefined,
    getter: (item: T) => R | null | undefined,
    defaultValue?: R
): R | null {
    if (!source) {
        return defaultValue !== undefined ? defaultValue : null;
    }
    try {
        const value = getter(source);
        return value !== null && value !== undefined ? value : (defaultValue !== undefined ? defaultValue : null);
    } catch (error) {
        return defaultValue !== undefined ? defaultValue : null;
    }
}

/**
 * Validates that required DTO fields are present
 * 
 * @param dto - DTO object to validate
 * @param requiredFields - Array of required field names
 * @throws Error if any required field is missing
 * 
 * @example
 * ```typescript
 * validateRequiredFields(userDTO, ['_id', 'name', 'email']);
 * ```
 */
export function validateRequiredFields<T>(
    dto: Partial<T>,
    requiredFields: (keyof T)[]
): void {
    for (const field of requiredFields) {
        if (dto[field] === undefined || dto[field] === null) {
            throw new Error(`Required DTO field missing: ${String(field)}`);
        }
    }
}

/**
 * Safely maps a populated field (Mongoose populate result)
 * 
 * @param field - Populated field (can be ObjectId, populated object, or null)
 * @param mapper - Optional mapper function to transform populated object
 * @returns Mapped value or null
 * 
 * @example
 * ```typescript
 * const companyRef = safeMapPopulated(user.company, (c) => ({
 *     _id: c._id.toString(),
 *     name: c.name
 * }));
 * ```
 */
export function safeMapPopulated<T extends { _id: ObjectId | string }, R>(
    field: ObjectId | string | T | null | undefined,
    mapper?: (entity: T) => R
): R | string | null {
    if (!field) return null;
    
    // If it's just an ID (not populated)
    if (field instanceof ObjectId || typeof field === 'string') {
        return typeof field === 'string' ? field : field.toString();
    }
    
    // If it's populated and we have a mapper
    if (mapper) {
        try {
            return mapper(field as T);
        } catch (error) {
            return null;
        }
    }
    
    // Default: return ID
    return objectIdToString((field as T)._id);
}

/**
 * Safely maps a number with validation
 * 
 * @param value - Number value that may be null/undefined
 * @param defaultValue - Default value if source is null/undefined/invalid
 * @returns Number value or default
 * 
 * @example
 * ```typescript
 * const price = safeMapNumber(unit.price, 0);
 * ```
 */
export function safeMapNumber(
    value: number | null | undefined,
    defaultValue: number = 0
): number {
    if (value === null || value === undefined || isNaN(value)) {
        return defaultValue;
    }
    return value;
}

/**
 * Safely maps a string with trimming and validation
 * 
 * @param value - String value that may be null/undefined
 * @param defaultValue - Default value if source is null/undefined/empty
 * @returns Trimmed string or default
 * 
 * @example
 * ```typescript
 * const name = safeMapString(company.name, 'Unnamed');
 * ```
 */
export function safeMapString(
    value: string | null | undefined,
    defaultValue: string = ''
): string | null | undefined {
    if (!value || typeof value !== 'string') {
        return defaultValue;
    }
    const trimmed = value.trim();
    return trimmed || defaultValue;
}

/**
 * Safely maps a boolean with validation
 * 
 * @param value - Boolean value that may be null/undefined
 * @param defaultValue - Default value if source is null/undefined
 * @returns Boolean value or default
 * 
 * @example
 * ```typescript
 * const isActive = safeMapBoolean(company.isActive, false);
 * ```
 */
export function safeMapBoolean(
    value: boolean | null | undefined,
    defaultValue: boolean = false
): boolean {
    if (value === null || value === undefined) {
        return defaultValue;
    }
    return Boolean(value);
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
    return {
        _id: u._id.toString(),
        name: u.name,
        surname: u.surname,
        photo: u.photo?._id != null ? String(u.photo._id) : undefined
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

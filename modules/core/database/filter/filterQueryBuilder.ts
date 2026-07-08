/**
 * Converts Filter DSL to MongoDB/Mongoose FilterQuery.
 * Recursive, safe, with field and operator validation.
 */

import type {FilterQuery} from "mongoose";
import type {FilterGroup, FilterRule} from "armonia/src/modules/core/database/filter/filter.types";
import type {FieldRegistry} from "armonia/src/modules/core/database/filter/fieldRegistry.types";
import {OPERATOR_HANDLERS} from "armonia/src/modules/core/database/filter/operators";

const FORBIDDEN_FIELD_PATTERNS = /^(__proto__|constructor|prototype)$/;
const INVALID_FIELD_PREFIX = /^[$.]/;

function isValidFieldPath(field: string): boolean {
    if (typeof field !== "string" || !field.trim()) return false;
    if (FORBIDDEN_FIELD_PATTERNS.test(field)) return false;
    if (INVALID_FIELD_PREFIX.test(field)) return false;
    return true;
}

export interface BuildOptions {
    strict?: boolean;
}

/**
 * Builds a MongoDB query condition from a single filter rule.
 */
function buildRuleCondition<T>(
    rule: FilterRule,
    registry: FieldRegistry,
    opts: BuildOptions
): FilterQuery<T> | null {
    if (!isValidFieldPath(rule.field)) {
        if (opts.strict) throw new Error(`Invalid field path: ${rule.field}`);
        return null;
    }

    const fieldConfig = registry.getField(rule.field);
    if (!fieldConfig) {
        if (opts.strict) throw new Error(`Unknown field: ${rule.field}`);
        return null;
    }

    const allowedOps = fieldConfig.operators;
    if (allowedOps && !allowedOps.includes(rule.operator)) {
        if (opts.strict) throw new Error(`Operator ${rule.operator} not allowed for field ${rule.field}`);
        return null;
    }

    const handler = OPERATOR_HANDLERS[rule.operator];
    if (!handler) {
        if (opts.strict) throw new Error(`Unknown operator: ${rule.operator}`);
        return null;
    }

    const condition = handler(rule.field, rule.value, fieldConfig);
    return condition as FilterQuery<T> | null;
}

/**
 * Recursively builds a MongoDB FilterQuery from a FilterGroup.
 *
 * @param group - The filter group (root or nested)
 * @param registry - Field registry with allowed fields and operators
 * @param opts - Optional: strict mode throws on invalid field/operator
 * @returns Mongoose FilterQuery, or empty object if no conditions
 */
export function buildMongoQuery<T>(
    group: FilterGroup,
    registry: FieldRegistry,
    opts: BuildOptions = {}
): FilterQuery<T> {
    const conditions: FilterQuery<T>[] = [];

    for (const rule of group.rules) {
        const cond = buildRuleCondition<T>(rule, registry, opts);
        if (cond && Object.keys(cond).length > 0) {
            conditions.push(cond);
        }
    }

    for (const child of group.groups) {
        const childQuery = buildMongoQuery<T>(child, registry, opts);
        if (childQuery && Object.keys(childQuery as object).length > 0) {
            conditions.push(childQuery);
        }
    }

    if (conditions.length === 0) return {} as FilterQuery<T>;
    if (conditions.length === 1) return conditions[0];

    const key = group.operator === "and" ? "$and" : "$or";
    return { [key]: conditions } as FilterQuery<T>;
}

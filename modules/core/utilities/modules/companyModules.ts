/**
 * Per-company module access.
 *
 * A company's effective modules are the modules granted to it (`Company.modules`, with
 * their dependency closure) intersected with the modules installed on this server
 * (`ENABLED_MODULES`). `core` is always included. A company without a `modules` list
 * gets every installed module, so documents written before the field existed keep
 * working.
 *
 * Effective lists are cached in Redis per company. Redis is optional: without it every
 * lookup reads the company document.
 */

import mongoose from "mongoose";
import {ObjectId} from "mongodb";
import {isRedisConnected, redisDel, redisGet, redisSetEx} from "@coreModule/connections/connectToRedis";
import {REDIS} from "@coreModule/environment";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {getEnabledModuleNames, loadModuleManifest, resolveModuleSelection} from "./enabledModules";

export type CompanyModulesSource = {modules?: string[] | null};

const KEY_PREFIX = "company_modules:";

const cacheKey = (companyId: string): string => `${KEY_PREFIX}${companyId}`;

/**
 * Dependency closure of `requested` — the form `Company.modules` is stored in. Names
 * missing from the manifest are dropped so stale data can never fail a request.
 */
export function closeCompanyModules(requested: string[]): string[] {
    const manifest = loadModuleManifest();
    return resolveModuleSelection(requested.filter((name) => name in manifest), manifest);
}

/** Dependency closure of `requested`, limited to modules installed on this server. */
export function normalizeCompanyModules(requested: string[]): string[] {
    const installed = new Set(getEnabledModuleNames());
    return closeCompanyModules(requested).filter((name) => installed.has(name));
}

export function effectiveCompanyModules(company: CompanyModulesSource): string[] {
    if (!Array.isArray(company.modules)) {
        return [...getEnabledModuleNames()];
    }
    return normalizeCompanyModules(company.modules);
}

export async function getCompanyModules(companyId: ObjectId | string): Promise<string[]> {
    const id = companyId.toString();
    if (isRedisConnected()) {
        const cached = await redisGet(cacheKey(id));
        if (cached) {
            try {
                return JSON.parse(cached) as string[];
            } catch {
                // Corrupt entry: fall through and overwrite it.
            }
        }
    }
    const company = await mongoose.model("Company").findById(new ObjectId(id)).select("modules").lean<CompanyModulesSource>();
    const modules = company ? effectiveCompanyModules(company) : ["core"];
    void redisSetEx(cacheKey(id), REDIS.ROLE_ACCESS_CACHE_TTL, JSON.stringify(modules));
    return modules;
}

export async function invalidateCompanyModules(companyId: ObjectId | string): Promise<void> {
    if (!isRedisConnected()) {
        return;
    }
    await redisDel(cacheKey(companyId.toString()));
}

export function isModuleEnabledForCompany(company: CompanyModulesSource, moduleName: string): boolean {
    return moduleName === "core" || effectiveCompanyModules(company).includes(moduleName);
}

export function assertModuleEnabledForCompany(company: CompanyModulesSource, moduleName: string, languageCode: string): void {
    if (!isModuleEnabledForCompany(company, moduleName)) {
        throw apiValidationException("module_not_enabled", "", null, languageCode);
    }
}

/**
 * Mongo clause matching companies that have `moduleName`. Stored lists are always
 * dependency-closed (see `normalizeCompanyModules`), so a plain element match is enough;
 * companies without a list have every installed module.
 */
export function companyModuleClause(moduleName: string): Record<string, unknown> {
    if (moduleName !== "core" && !getEnabledModuleNames().includes(moduleName)) {
        return {_id: {$exists: false}};
    }
    return {$or: [{modules: moduleName}, {modules: {$exists: false}}, {modules: null}]};
}

export async function companyIdsWithModule(moduleName: string): Promise<ObjectId[]> {
    const companies = await mongoose.model("Company").find(companyModuleClause(moduleName)).select("_id").lean<{_id: ObjectId}[]>();
    return companies.map((company) => company._id);
}

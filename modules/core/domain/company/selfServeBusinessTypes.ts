import type {ClientSession} from "mongoose";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import type {serverLogger} from "@coreModule/loggers/serverLog";

/** What a module gets once a company of one of its business types has been created by self-serve sign-up (D178). */
export type SelfServeCreatedContext = {
    /** The new company, already saved with its modules, default roles and its creator as admin. */
    company: ICompany;
    session: ClientSession;
    logger: serverLogger;
    languageCode: string;
};

/**
 * A kind of business a person may create on the portal by themselves (D178). Modules declare theirs in
 * `moduleBootstrap.selfServeBusinessTypes`, so core names no vertical (CORE-01).
 */
export type SelfServeBusinessType = {
    /** Stable key the portal sends, e.g. `carRental`; unique across modules. */
    key: string;
    /** Modules the new company starts with besides core; the company adds their dependencies itself. */
    modules: string[];
    /** The module's own setup once the company exists (e.g. opting it in to the portal); runs in the company's tenant. */
    onCreated?: (ctx: SelfServeCreatedContext) => Promise<void>;
};

export type RegisteredSelfServeBusinessType = SelfServeBusinessType & {
    /** Folder name of the module that declared it. */
    module: string;
};

const businessTypes = new Map<string, RegisteredSelfServeBusinessType>();

/**
 * Registers a module's business types. The bootstrap loader calls it with the module's folder name; loading the same
 * module again replaces its entries, while a key another module already declared is a configuration error.
 */
export function registerSelfServeBusinessTypes(module: string, types: readonly SelfServeBusinessType[]): void {
    for (const type of types) {
        const existing = businessTypes.get(type.key);
        if (existing && existing.module !== module) {
            throw new Error(`Self-serve business type '${type.key}' of module '${module}' is already declared by '${existing.module}'`);
        }
        businessTypes.set(type.key, {...type, module});
    }
}

/** The business types this server offers, in the order their modules were loaded. */
export function selfServeBusinessTypes(): RegisteredSelfServeBusinessType[] {
    return [...businessTypes.values()];
}

/** The business type with this key, or undefined when no loaded module offers it. */
export function findSelfServeBusinessType(key: string): RegisteredSelfServeBusinessType | undefined {
    return businessTypes.get(key);
}

/** Test helper: forget every registration. */
export function clearSelfServeBusinessTypes(): void {
    businessTypes.clear();
}

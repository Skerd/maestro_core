/**
 * The public things people can report to the platform (D191). Each module declares its own in
 * `moduleBootstrap.reportables` (core declares the company and chat messages), so core names no vertical (CORE-01): the
 * platform's report desk reads a reported record through its definition and hides or shows it the same way.
 *
 * @module domain/reports/reportables
 */

import type {ClientSession, Model} from "mongoose";
import type {ObjectId} from "mongodb";
import type {serverLogger} from "@coreModule/loggers/serverLog";
import {isPlatformHideable} from "@coreModule/database/plugins/platformHiddenPlugin";

/** One reported record, as the report desk reads it. Core calls this across tenants: read the record by its id alone. */
export type ReportableReadContext = {
    recordId: ObjectId;
    session?: ClientSession;
    logger: serverLogger;
    languageCode: string;
};

/** Hiding or showing one record. Core calls it in the tenant of the company the snapshot named. */
export type ReportableHideContext = ReportableReadContext & {
    /** True hides the record wherever the public sees it; false shows it again. */
    hidden: boolean;
    /** The platform admin who decided. */
    decidedBy: ObjectId;
};

/** What the report desk shows about a reported record. */
export type ReportableSnapshot = {
    /** Its name or a short excerpt, as the platform should recognise it. */
    title: string;
    /** The company that owns it. */
    companyId: ObjectId;
    /** The account that wrote it, for things a person writes (a review, a message, a job, a bid); a ban targets it. */
    authorAccountId?: ObjectId;
    /** Where the platform can see it, a portal or panel path, when it has a page. */
    url?: string;
    /** Whether the platform already hides it. */
    hidden: boolean;
};

export type ReportableDefinition = {
    /** Stable kind the Report button sends, namespaced by module (`marketplace.listing`); unique across modules. */
    kind: string;
    /** The kind's name for the report desk, by language code (`en-US`, `de-CH`, `fr-FR`, `it-IT`, `sq-AL`). */
    typeLabel: Record<string, string>;
    /** The record as the report desk shows it, or null when it no longer exists. */
    snapshot: (ctx: ReportableReadContext) => Promise<ReportableSnapshot | null>;
} & (
    | {
        /** A model with platformHiddenPlugin: core hides and shows the record itself, and public reads leave it out. */
        model: Model<any>;
        /**
         * What else changes once the record is hidden or shown (a rating counted again, a live board told), run in the
         * company that keeps the record, in the decision's transaction.
         */
        onHidden?: (ctx: ReportableHideContext & {companyId: ObjectId}) => Promise<void>;
        setHidden?: never;
    }
    /** A record hidden some other way (a company hidden from the portal): the module hides and shows it. */
    | {setHidden: (ctx: ReportableHideContext) => Promise<void>; model?: never; onHidden?: never}
);

export type RegisteredReportable = ReportableDefinition & {
    /** Folder name of the module that declared it (`core` for core's own). */
    module: string;
};

const reportables = new Map<string, RegisteredReportable>();

/**
 * Registers a module's reportable kinds. The bootstrap loader calls it with the module's folder name; loading the same
 * module again replaces its entries, while a kind another module already declared is a configuration error.
 */
export function registerReportables(module: string, definitions: readonly ReportableDefinition[]): void {
    for (const definition of definitions) {
        if (definition.model && !isPlatformHideable(definition.model)) {
            throw new Error(`Reportable kind '${definition.kind}' names ${definition.model.modelName}, which does not apply platformHiddenPlugin`);
        }
        const existing = reportables.get(definition.kind);
        if (existing && existing.module !== module) {
            throw new Error(`Reportable kind '${definition.kind}' of module '${module}' is already declared by '${existing.module}'`);
        }
        reportables.set(definition.kind, {...definition, module});
    }
}

/** The reportable kind with this name, or undefined when no loaded module declares it. */
export function findReportable(kind: string): RegisteredReportable | undefined {
    return reportables.get(kind);
}

/** Every reportable kind this server knows, in the order their modules were loaded. */
export function registeredReportables(): RegisteredReportable[] {
    return [...reportables.values()];
}

/** The kind's name in this language, else English, else the kind itself. */
export function reportableTypeLabel(kind: string, languageCode: string): string {
    const labels = reportables.get(kind)?.typeLabel;
    return labels?.[languageCode] ?? labels?.["en-US"] ?? kind;
}

/** Test helper: forget every registration. */
export function clearReportables(): void {
    reportables.clear();
}

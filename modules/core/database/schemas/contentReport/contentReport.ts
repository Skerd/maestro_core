import {Document, model, Schema, SchemaTypes} from "mongoose";
import type {ObjectId} from "mongodb";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import platformOnlyPlugin from "@coreModule/database/plugins/platformOnlyPlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import {ILifeCyclePluginFields, IOwnershipPluginFields, ISoftDeletePluginFields} from "@coreModule/database/types/plugin-fields";
import {addModelData} from "@coreModule/database/collections";
import {applyContentReportIndexes} from "@coreModule/database/schemas/contentReport/contentReport.indexes";
import {contentReportViews} from "@coreModule/database/schemas/contentReport/contentReport.views";
import {
    REPORT_COMMENT_MAX,
    REPORT_DECISION_NOTE_MAX,
    REPORT_DECISIONS,
    REPORT_KIND_MAX,
    REPORT_REASONS,
    REPORT_STATUSES,
    type ReportDecision,
    type ReportReason,
    type ReportStatus,
} from "armonia/src/modules/core/api/reports/report.form.validator";

const serverWritten = {
    self: {write: "no-permission"},
    others: {write: "no-permission"},
};

/** An id the desk shows by name elsewhere (the company's, the reporter's email): no column, no filter. */
const hiddenColumn = {visible: false, filterable: false};

/**
 * A report someone sent the platform about a public thing (D191): what it is (its module's reportable kind and id, with
 * the company that owns it and what it looked like then), why, who sent it, and the platform's decision. Kept in the
 * platform company and seen only there: the reported company never learns who reported it.
 */
export interface IContentReport extends Document, IOwnershipPluginFields, ISoftDeletePluginFields, ILifeCyclePluginFields {
    kind: string;
    recordId: ObjectId;
    recordCompany: ObjectId;
    recordCompanyName: string;
    recordTitle: string;
    recordUrl?: string;
    /** The account that wrote the thing, for a review, a message, a job or a bid: who a ban reaches. */
    authorAccount?: ObjectId;
    reason: ReportReason;
    comment?: string;
    reporter: ObjectId;
    reporterEmail: string;
    status: ReportStatus;
    decision?: ReportDecision;
    decisionNote?: string;
    decidedBy?: ObjectId;
    decidedAt?: Date;
    /** When a reversible decision was undone (the item shown again, the suspension or ban lifted). */
    undoneAt?: Date;
    undoneBy?: ObjectId;
}

const ContentReportSchema = new Schema<IContentReport>(
    {
        kind: {type: SchemaTypes.String, required: true, trim: true, maxlength: REPORT_KIND_MAX, permissions: serverWritten},
        recordId: {type: SchemaTypes.ObjectId, required: true, permissions: serverWritten, dynamicTableConfiguration: hiddenColumn},
        recordCompany: {type: SchemaTypes.ObjectId, required: true, permissions: serverWritten, dynamicTableConfiguration: hiddenColumn},
        recordCompanyName: {type: SchemaTypes.String, required: true, trim: true, maxlength: 512, permissions: serverWritten},
        recordTitle: {type: SchemaTypes.String, required: true, trim: true, maxlength: 512, permissions: serverWritten},
        recordUrl: {type: SchemaTypes.String, trim: true, maxlength: 1024, permissions: serverWritten},
        authorAccount: {type: SchemaTypes.ObjectId, permissions: serverWritten, dynamicTableConfiguration: hiddenColumn},
        reason: {type: SchemaTypes.String, required: true, enum: [...REPORT_REASONS], permissions: serverWritten},
        comment: {type: SchemaTypes.String, trim: true, maxlength: REPORT_COMMENT_MAX, permissions: serverWritten},
        reporter: {type: SchemaTypes.ObjectId, required: true, permissions: serverWritten, dynamicTableConfiguration: hiddenColumn},
        reporterEmail: {type: SchemaTypes.String, required: true, trim: true, maxlength: 320, permissions: serverWritten},
        status: {type: SchemaTypes.String, required: true, enum: [...REPORT_STATUSES], default: "open", permissions: serverWritten,
            dynamicTableConfiguration: {enumTones: {open: "warning", closed: "neutral"}}},
        decision: {type: SchemaTypes.String, enum: [...REPORT_DECISIONS], permissions: serverWritten,
            dynamicTableConfiguration: {enumTones: {dismissed: "neutral", itemHidden: "warning", companyHidden: "warning", companySuspended: "danger", accountBanned: "danger"}}},
        decisionNote: {type: SchemaTypes.String, trim: true, maxlength: REPORT_DECISION_NOTE_MAX, permissions: serverWritten},
        decidedBy: {type: SchemaTypes.ObjectId, permissions: serverWritten, dynamicTableConfiguration: hiddenColumn},
        decidedAt: {type: SchemaTypes.Date, permissions: serverWritten},
        undoneAt: {type: SchemaTypes.Date, permissions: serverWritten},
        undoneBy: {type: SchemaTypes.ObjectId, permissions: serverWritten, dynamicTableConfiguration: hiddenColumn},
    },
    {
        accessMode: "loose",
        permissions: {
            self: {
                create: "no-permission",
                delete: "no-permission",
                restore: "no-permission",
            },
        },
    },
);

ownershipPlugin(ContentReportSchema);
// The platform's (D161 pattern): only the platform company reads reports and decides them.
platformOnlyPlugin(ContentReportSchema);
auditPlugin(ContentReportSchema);
softDeletePlugin(ContentReportSchema);
lifeCyclePlugin(ContentReportSchema);
applyContentReportIndexes(ContentReportSchema);
const ContentReport = model<IContentReport>("ContentReport", ContentReportSchema);
normalizeSchemaPermissions(ContentReport);
export default ContentReport;

addModelData(ContentReport, contentReportViews);

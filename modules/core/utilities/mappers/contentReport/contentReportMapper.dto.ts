import type {ContentReport} from "armonia/src/modules/core/api/reports/contentReport.dto";
import type {ApiSelectDatum} from "armonia/src/modules/core/types/shared.types";
import type {IContentReport} from "@coreModule/database/schemas/contentReport/contentReport";
import {reportableTypeLabel} from "@coreModule/domain/reports/reportables";
import {mapLifeCycleToDTO, mapOwnershipToDTO, mapSoftDeleteToDTO} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";
import {dateToISOString} from "@coreModule/utilities/mappers/common.mapper";

/** A report for the desk, with its kind named in the reader's language (the module that declared the kind names it). */
export function contentReportToDTO(model: IContentReport, languageCode: string): ContentReport {
    return {
        _id: model._id.toString(),
        kind: model.kind,
        kindLabel: reportableTypeLabel(model.kind, languageCode),
        recordId: model.recordId.toString(),
        recordCompany: model.recordCompany.toString(),
        recordCompanyName: model.recordCompanyName,
        recordTitle: model.recordTitle,
        recordUrl: model.recordUrl,
        hasAuthor: !!model.authorAccount,
        reason: model.reason,
        comment: model.comment,
        reporterEmail: model.reporterEmail,
        status: model.status,
        decision: model.decision,
        decisionNote: model.decisionNote,
        decidedAt: model.decidedAt ? dateToISOString(model.decidedAt) : undefined,
        undoneAt: model.undoneAt ? dateToISOString(model.undoneAt) : undefined,
        ...mapSoftDeleteToDTO(model),
        ...mapOwnershipToDTO(model),
        ...mapLifeCycleToDTO(model),
    };
}

export function contentReportsToDTO(models: IContentReport[], languageCode: string): ContentReport[] {
    return models.map((model) => contentReportToDTO(model, languageCode));
}

export function contentReportsToSelect(models: IContentReport[]): ApiSelectDatum[] {
    return models.map((model) => ({value: model._id.toString(), label: model.recordTitle}));
}

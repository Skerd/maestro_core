/**
 * The platform's report desk (D191): the reports people sent, newest open first, and the decisions
 * (`ContentReportActions`: `counts`, `decide`, `undo`). The reports are the platform company's (platformOnlyPlugin)
 * and the server writes every field: the desk reads them and decides, it never creates or edits one.
 *
 * @module api/reports/private/reportDesk
 */

import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import ContentReport from "@coreModule/database/schemas/contentReport/contentReport";
import {contentReportService} from "@coreModule/database/schemas/contentReport/contentReport.service";
import {ContentReportActions} from "@coreModule/database/schemas/contentReport/contentReport.actions";
import {
    contentReportsToDTO,
    contentReportsToSelect,
    contentReportToDTO,
} from "@coreModule/utilities/mappers/contentReport/contentReportMapper.dto";
import {DEFAULT_EXCEPTION_LANGUAGE} from "armonia/src/modules/core/helpers/exceptions";
import {contentReportWriteFormSchema} from "armonia/src/modules/core/api/reports/contentReportWrite.form.validator";

export const basePath = "/api/reports/desk";

export const {router} = createCrudRouter({
    collectionName: "contentreports",
    model: ContentReport,
    service: contentReportService,
    entityName: "Content report",
    createSchema: contentReportWriteFormSchema,
    editSchema: contentReportWriteFormSchema,
    toDTO: (doc) => contentReportToDTO(doc, DEFAULT_EXCEPTION_LANGUAGE),
    toDTOArray: (docs) => contentReportsToDTO(docs, DEFAULT_EXCEPTION_LANGUAGE),
    toSelect: contentReportsToSelect,
    selectSearchField: "recordTitle",
    buildCreateData: () => ({}),
    buildUpdateData: () => ({}),
    actions: ContentReportActions,
    // Open reports first ("open" sorts after "closed"), newest first.
    defaultSort: {status: -1, createdAt: -1},
    enrichList: async (docs, params) => contentReportsToDTO(docs, params.languageCode),
    enrichSingle: async (doc, params) => contentReportToDTO(doc, params.languageCode),
});

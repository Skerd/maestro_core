import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {lifecycleSheetGroup} from "../shared/lifecycleSheetGroup";

const card = (name: string, label: string, icon: string, extra: Record<string, unknown> = {}) => ({
    render: "#DisplayCard",
    dependent: name,
    permissions: {read: name},
    field: {name, widget: "#DisplayCard", label, widgetProps: {icon, ...extra}},
});

/** One report on the platform's report desk (D191): what was reported and why, then the decision. */
export const contentReportSheetView: ViewConfig = {
    model: "contentreports",
    viewType: "sheet",
    accessModel: "contentreports",
    apiUrl: "/api/reports/desk",
    sheetWidget: "#ContentReportSheetView",
    header: {
        titleField: "recordTitle",
        subtitleKey: "report",
        showCloseButton: true,
    },
    nodes: [
        {
            render: "#SheetGroup",
            props: {title: "reported"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 2},
                    children: [
                        card("kindLabel", "kind", "#Category"),
                        card("recordCompanyName", "recordCompany", "#Building"),
                        card("recordTitle", "recordTitle", "#FileText"),
                        card("recordUrl", "recordUrl", "#Link"),
                    ],
                },
            ],
        },
        {
            render: "#SheetGroup",
            props: {title: "report"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 2},
                    children: [
                        card("reason", "reason", "#Flag", {languageKeyCategory: "reasons"}),
                        card("reporterEmail", "reporter", "#User"),
                        card("comment", "comment", "#MessageCircle"),
                    ],
                },
            ],
        },
        {
            render: "#SheetGroup",
            props: {title: "decision"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 2},
                    children: [
                        card("status", "status", "#CircleCheck", {languageKeyCategory: "statuses"}),
                        card("decision", "decision", "#Gavel", {languageKeyCategory: "decisions"}),
                        card("decisionNote", "decisionNote", "#Notes"),
                        card("decidedAt", "decidedAt", "#Calendar", {type: "dateTime"}),
                        card("undoneAt", "undoneAt", "#ArrowBackUp", {type: "dateTime"}),
                    ],
                },
            ],
        },
        lifecycleSheetGroup,
    ],
};

export const contentReportViews: ViewConfig[] = [contentReportSheetView];

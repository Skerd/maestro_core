import type {ViewNode} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";

const user = (name: string, label: string, icon: string): ViewNode => ({
    render: "#DisplayCard",
    dependent: name,
    permissions: {read: name},
    field: {
        name,
        widget: "#DisplayCard",
        label,
        widgetProps: {icon, parent: name, valuePath: ["name", "surname"], joinSeparator: " "},
    },
});

const dateTime = (name: string, label: string): ViewNode => ({
    render: "#DisplayCard",
    dependent: name,
    permissions: {read: name},
    field: {name, widget: "#DisplayCard", label, widgetProps: {icon: "#Calendar", format: "dateTime"}},
});

/**
 * The request record of a requestable platform list entry (requestablePlugin, D160), placed after `lifecycleSheetGroup`:
 * status, who requested it and when, and who decided, when and why. Shown only on entries that were requested
 * (`requestedAt`); labels come from the sheet's dictionary (`requestApproval`, `requestStatus`, `requestStatusValues.*`, …).
 */
export const requestSheetGroup: ViewNode = {
    render: "#SheetGroup",
    // A management section like lifecycle, with the same neutral accent; its icon and title tell the two apart.
    props: {title: "requestApproval", defaultOpen: true, titleIcon: "#Send", accent: "neutral"},
    dependentAny: ["requestedAt"],
    permissions: {readAny: ["requestStatus", "requestedAt", "requestedBy", "requestedByCompanyName", "decidedAt", "decidedBy", "decisionNotes"]},
    children: [
        {
            render: "#SheetGrid",
            props: {columns: 3},
            children: [
                {
                    render: "#DisplayCard",
                    permissions: {read: "requestStatus"},
                    field: {
                        name: "requestStatus",
                        widget: "#DisplayCard",
                        label: "requestStatus",
                        widgetProps: {
                            icon: "#CircleDot",
                            languageKeyCategory: "requestStatusValues",
                            type: "enum",
                            variantLookupField: "requestStatus",
                            variantLookupMap: {requested: "warning", approved: "success", rejected: "destructive", withdrawn: "default"},
                        },
                    },
                },
                dateTime("requestedAt", "requestedAt"),
                user("requestedBy", "requestedBy", "#User"),
                {
                    render: "#DisplayCard",
                    dependent: "requestedByCompanyName",
                    permissions: {read: "requestedByCompanyName"},
                    field: {
                        name: "requestedByCompanyName",
                        widget: "#DisplayCard",
                        label: "requestedByCompanyName",
                        widgetProps: {
                            icon: "#Building",
                            // The name is kept on the entry; the id opens that company's sheet.
                            linkedRefPath: "requestedByCompany",
                            linkedSheetModel: "companies",
                            linkedSheetWidget: "#CompanySheetView",
                            linkedSheetEntityProp: "company",
                        },
                    },
                },
                dateTime("decidedAt", "decidedAt"),
                user("decidedBy", "decidedBy", "#UserCheck"),
                {
                    render: "#DisplayCard",
                    dependent: "decisionNotes",
                    permissions: {read: "decisionNotes"},
                    field: {
                        name: "decisionNotes",
                        widget: "#DisplayCard",
                        label: "decisionNotes",
                        widgetProps: {icon: "#Notes"},
                    },
                },
            ],
        },
    ],
};

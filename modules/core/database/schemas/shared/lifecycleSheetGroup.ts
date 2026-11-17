import type {ViewNode} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";

/**
 * Shared audit / soft-delete sheet section used by city, listing, and PM sheets.
 * Fields: createdAt, updatedAt, createdBy, deletedAt, deletedBy.
 */
export const lifecycleSheetGroup: ViewNode = {
    render: "#SheetGroup",
    // A management section, not the record's own data: its own icon and a neutral accent on every sheet.
    props: {title: "lifecycle", defaultOpen: true, titleIcon: "#History", accent: "neutral"},
    dependentAny: ["createdAt", "updatedAt", "createdBy", "deletedAt", "deletedBy"],
    permissions: { readAny: ["createdAt", "updatedAt", "createdBy", "deletedAt", "deletedBy"] },
    children: [
        {
            render: "#SheetGrid",
            props: {columns: 3},
            children: [
                {
                    render: "#DisplayCard",
                    permissions: {read: "createdAt"},
                    field: {
                        name: "createdAt",
                        widget: "#DisplayCard",
                        label: "createdAt",
                        widgetProps: {icon: "#Calendar", format: "dateTime"},
                    },
                },
                {
                    render: "#DisplayCard",
                    permissions: {read: "updatedAt"},
                    field: {
                        name: "updatedAt",
                        widget: "#DisplayCard",
                        label: "updatedAt",
                        widgetProps: {icon: "#Calendar", format: "dateTime"},
                    },
                },
                {
                    render: "#DisplayCard",
                    // A record the system made (a scheduled action, a seeded row) has no author to show (TD-F115).
                    dependent: "createdBy",
                    permissions: {read: "createdBy"},
                    field: {
                        name: "createdBy",
                        widget: "#DisplayCard",
                        label: "createdBy",
                        widgetProps: {
                            icon: "#User",
                            avatarPath: "createdBy.photo",
                            parent: "createdBy",
                            valuePath: ["name", "surname"],
                            joinSeparator: " ",
                        },
                    },
                },
                {
                    render: "#DisplayCard",
                    dependent: "deletedAt",
                    permissions: {read: "deletedAt"},
                    field: {
                        name: "deletedAt",
                        widget: "#DisplayCard",
                        label: "deletedAt",
                        widgetProps: {icon: "#Calendar", format: "dateTime"},
                    },
                },
                {
                    render: "#DisplayCard",
                    dependent: "deletedBy",
                    permissions: {read: "deletedBy"},
                    field: {
                        name: "deletedBy",
                        widget: "#DisplayCard",
                        label: "deletedBy",
                        widgetProps: {
                            icon: "#User",
                            parent: "deletedBy",
                            valuePath: ["name", "surname"],
                            joinSeparator: " ",
                        },
                    },
                },
            ],
        },
    ],
};

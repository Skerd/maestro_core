import type {ViewNode} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";

/**
 * Shared audit / soft-delete sheet section used by city, listing, and PM sheets.
 * Fields: createdAt, updatedAt, createdBy, deletedAt, deletedBy.
 */
export const lifecycleSheetGroup: ViewNode = {
    render: "#SheetGroup",
    props: {title: "lifecycle", defaultOpen: true},
    children: [
        {
            render: "#SheetGrid",
            props: {columns: 2},
            children: [
                {
                    render: "#SmallInfoCard",
                    permissions: {read: "createdAt"},
                    field: {
                        name: "createdAt",
                        widget: "#SmallInfoCard",
                        label: "createdAt",
                        widgetProps: {icon: "#Calendar", format: "dateTime"},
                    },
                },
                {
                    render: "#SmallInfoCard",
                    permissions: {read: "updatedAt"},
                    field: {
                        name: "updatedAt",
                        widget: "#SmallInfoCard",
                        label: "updatedAt",
                        widgetProps: {icon: "#Calendar", format: "dateTime"},
                    },
                },
                {
                    render: "#SmallInfoCard",
                    permissions: {read: "createdBy"},
                    field: {
                        name: "createdBy",
                        widget: "#SmallInfoCard",
                        label: "createdBy",
                        widgetProps: {
                            icon: "#User",
                            parent: "createdBy",
                            valuePath: ["name", "surname"],
                            joinSeparator: " ",
                        },
                    },
                },
                {
                    render: "#SmallInfoCard",
                    dependent: "deletedAt",
                    permissions: {read: "deletedAt"},
                    field: {
                        name: "deletedAt",
                        widget: "#SmallInfoCard",
                        label: "deletedAt",
                        widgetProps: {icon: "#Calendar", format: "dateTime"},
                    },
                },
                {
                    render: "#SmallInfoCard",
                    dependent: "deletedBy",
                    permissions: {read: "deletedBy"},
                    field: {
                        name: "deletedBy",
                        widget: "#SmallInfoCard",
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

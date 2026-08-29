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

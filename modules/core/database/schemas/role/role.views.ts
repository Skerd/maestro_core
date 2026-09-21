import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {lifecycleSheetGroup} from "../shared/lifecycleSheetGroup";

export const roleSheetView: ViewConfig = {
    model: "roles",
    viewType: "sheet",
    accessModel: "roles",
    apiUrl: "/api/company/roles",
    header: {
        titleField: "name",
        showCloseButton: true,
    },
    nodes: [
        {
            render: "#SheetGroup",
            props: {title: "overview"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 3},
                    children: [
                        {
                            render: "#DisplayCard",
                            permissions: {read: "name"},
                            field: {
                                name: "name",
                                widget: "#DisplayCard",
                                label: "name",
                                widgetProps: {icon: "#Shield"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "slug"},
                            field: {
                                name: "slug",
                                widget: "#DisplayCard",
                                label: "slug",
                                widgetProps: {icon: "#Hash"},
                            },
                        },
                    ],
                },
                {
                    render: "#SheetGrid",
                    props: {columns: 1},
                    children: [
                        {
                            render: "#DisplayCard",
                            dependent: "description",
                            permissions: {read: "description"},
                            field: {
                                name: "description",
                                widget: "#DisplayCard",
                                label: "description",
                                widgetProps: {icon: "#AlignLeft", expandable: true, maxLength: 250},
                            },
                        },
                    ],
                },
            ],
        },
        lifecycleSheetGroup,
    ],
};

export const roleViews: ViewConfig[] = [roleSheetView];

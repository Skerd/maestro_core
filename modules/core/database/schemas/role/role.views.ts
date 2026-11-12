import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {lifecycleSheetGroup} from "../shared/lifecycleSheetGroup";
import {ROLE_DESCRIPTION_MAX} from "armonia/src/modules/core/api/company/private/roles/role.schema-def";

const API_URL = "/api/company/roles";

export const roleSheetView: ViewConfig = {
    model: "roles",
    viewType: "sheet",
    accessModel: "roles",
    apiUrl: API_URL,
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

// The template select and the permission matrix render below these fields from the sinfonia roles page.
const roleCreateFormNodes: ViewConfig["nodes"] = [
    {
        render: "#FormGrid",
        props: {columns: 1},
        children: [
            {
                render: "#Field",
                field: {
                    name: "name",
                    widget: "#Input",
                    label: "form.nameLabel",
                    placeholder: "form.namePlaceholder",
                    description: "form.nameDescription",
                    required: true,
                },
            },
            {
                render: "#Field",
                field: {
                    name: "description",
                    widget: "#Textarea",
                    label: "form.descriptionLabel",
                    placeholder: "form.descriptionPlaceholder",
                    description: "form.descriptionHelp",
                    widgetProps: {rows: 3, maxLength: ROLE_DESCRIPTION_MAX},
                },
            },
        ],
    },
];

const roleEditFormNodes: ViewConfig["nodes"] = [
    {
        render: "#FormGrid",
        props: {columns: 1},
        permissions: {
            readAny: ["name", "description"],
            writeAny: ["name", "description"],
        },
        children: [
            {
                render: "#Field",
                permissions: {read: "name", write: "name"},
                field: {
                    name: "name",
                    widget: "#Input",
                    label: "form.nameLabel",
                    placeholder: "form.namePlaceholder",
                    description: "form.nameDescription",
                    required: true,
                },
            },
            {
                render: "#Field",
                permissions: {read: "description", write: "description"},
                field: {
                    name: "description",
                    widget: "#Textarea",
                    label: "form.descriptionLabel",
                    placeholder: "form.descriptionPlaceholder",
                    description: "form.descriptionHelp",
                    widgetProps: {rows: 3, maxLength: ROLE_DESCRIPTION_MAX},
                },
            },
        ],
    },
];

export const roleCreateFormView: ViewConfig = {
    model: "roles",
    viewType: "form",
    viewMode: "create",
    accessModel: "roles",
    apiUrl: API_URL,
    method: "PUT",
    nodes: roleCreateFormNodes,
};

export const roleEditFormView: ViewConfig = {
    model: "roles",
    viewType: "form",
    viewMode: "edit",
    accessModel: "roles",
    apiUrl: API_URL,
    method: "PATCH",
    nodes: roleEditFormNodes,
};

export const roleViews: ViewConfig[] = [roleSheetView, roleCreateFormView, roleEditFormView];

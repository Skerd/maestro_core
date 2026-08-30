import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {
    STATE_CODE_MAX,
    STATE_NAME_MAX,
} from "armonia/src/modules/core/api/auxiliary/private/state/state.schema-def";
import {lifecycleSheetGroup} from "../shared/lifecycleSheetGroup";

export const stateSheetView: ViewConfig = {
    model: "states",
    viewType: "sheet",
    accessModel: "states",
    apiUrl: "/api/auxiliary/state",
    header: {
        titleField: "name",
        subtitleKey: "state",
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
                                widgetProps: {icon: "#Tag"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "code"},
                            field: {
                                name: "code",
                                widget: "#DisplayCard",
                                label: "code",
                                widgetProps: {icon: "#Tag"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "country"},
                            field: {
                                name: "country.name",
                                widget: "#DisplayCard",
                                label: "country",
                                widgetProps: {
                                    icon: "#Globe",
                                    linkedRefPath: "country",
                                    linkedSheetModel: "countries",
                                    linkedSheetWidget: "#CountrySheetView",
                                    linkedSheetEntityProp: "country",
                                    flagCodePath: "country.code"
                                },
                            },
                        },
                    ],
                },
            ],
        },
        lifecycleSheetGroup,
    ],
};

const stateCreateFormNodes: ViewConfig["nodes"] = [
    {
        render: "#FormGrid",
        props: {columns: 3},
        children: [
            {
                render: "#Field",
                field: {
                    name: "name",
                    widget: "#Input",
                    label: "form.nameLabel",
                    placeholder: "form.namePlaceholder",
                    required: true,
                    widgetProps: {maxLength: STATE_NAME_MAX},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "code",
                    widget: "#Input",
                    label: "form.codeLabel",
                    placeholder: "form.codePlaceholder",
                    required: true,
                    widgetProps: {maxLength: STATE_CODE_MAX},
                },
            },
            {
                render: "#Field",
                props: {skipRenderWhenFormExtraTruthy: "countryIdLocked"},
                field: {
                    name: "country",
                    widget: "#ApiSelect",
                    label: "form.countryLabel",
                    placeholder: "form.countryPlaceholder",
                    widgetProps: {apiUrl: "/api/auxiliary/country/select"},
                },
            },
        ],
    },
];

const stateEditFormNodes: ViewConfig["nodes"] = [
    {
        render: "#FormGrid",
        props: {columns: 3},
        permissions: {writeAny: ["name", "code", "country"]},
        children: [
            {
                render: "#Field",
                field: {
                    name: "name",
                    widget: "#Input",
                    label: "form.nameLabel",
                    placeholder: "form.namePlaceholder",
                    required: true,
                    widgetProps: {maxLength: STATE_NAME_MAX},
                },
                permissions: {write: "name", read: "name"},
            },
            {
                render: "#Field",
                field: {
                    name: "code",
                    widget: "#Input",
                    label: "form.codeLabel",
                    placeholder: "form.codePlaceholder",
                    required: true,
                    widgetProps: {maxLength: STATE_CODE_MAX},
                },
                permissions: {write: "code", read: "code"},
            },
            {
                render: "#Field",
                props: {skipRenderWhenFormExtraTruthy: "countryIdLocked"},
                field: {
                    name: "country",
                    widget: "#ApiSelect",
                    label: "form.countryLabel",
                    placeholder: "form.countryPlaceholder",
                    widgetProps: {
                        apiUrl: "/api/auxiliary/country/select",
                        pageSize: 200
                    }
                },
                permissions: {write: "country", read: "country"},
            },
        ],
    },
];

export const stateCreateFormView: ViewConfig = {
    model: "states",
    viewType: "form",
    viewMode: "create",
    accessModel: "states",
    apiUrl: "/api/auxiliary/state",
    method: "PUT",
    nodes: stateCreateFormNodes,
};

export const stateEditFormView: ViewConfig = {
    model: "states",
    viewType: "form",
    viewMode: "edit",
    accessModel: "states",
    apiUrl: "/api/auxiliary/state",
    method: "PATCH",
    nodes: stateEditFormNodes,
};

export const stateViews: ViewConfig[] = [stateSheetView, stateCreateFormView, stateEditFormView];

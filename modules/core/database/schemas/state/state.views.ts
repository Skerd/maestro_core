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
                            dependent: "name",
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
                            dependent: "code",
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
        props: {columns: 2},
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

const stateEditFormHiddenId: ViewConfig["nodes"] = [
    {
        render: "#Field",
        field: {
            name: "_id",
            widget: "#Input",
            widgetProps: {
                type: "hidden",
                className: "sr-only !absolute !h-px !w-px !p-0 !m-0 !border-0 !overflow-hidden",
            },
        },
    },
];

const stateEditFormNodes: ViewConfig["nodes"] = [
    ...stateEditFormHiddenId,
    {
        render: "#FormGrid",
        props: {columns: 2},
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

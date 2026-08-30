import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {CITY_NAME_MAX} from "armonia/src/modules/core/api/auxiliary/private/city/city.schema-def";
import {lifecycleSheetGroup} from "../shared/lifecycleSheetGroup";

export const citySheetView: ViewConfig = {
    model: "cities",
    viewType: "sheet",
    accessModel: "cities",
    apiUrl: "/api/auxiliary/city",
    header: {
        titleField: "name",
        subtitleKey: "city",
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
                            permissions: {read: "state"},
                            field: {
                                name: "state.name",
                                widget: "#DisplayCard",
                                label: "state",
                                widgetProps: {
                                    icon: "#Layers",
                                    linkedRefPath: "state",
                                    linkedSheetModel: "states",
                                    linkedSheetWidget: "#StateSheetView",
                                    linkedSheetEntityProp: "state",
                                },
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
                                    flagCodePath: "country.code",
                                    linkedRefPath: "country",
                                    linkedSheetModel: "countries",
                                    linkedSheetWidget: "#CountrySheetView",
                                    linkedSheetEntityProp: "country",
                                },
                            },
                        },
                    ]
                }
            ],
        },
        lifecycleSheetGroup,
    ],
};

const cityCreateFormNodes: ViewConfig["nodes"] = [
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
                    widgetProps: {maxLength: CITY_NAME_MAX},
                },
            },
            {
                render: "#Field",
                props: {skipRenderWhenFormExtraTruthy: "lockCountrySelect"},
                field: {
                    name: "country",
                    widget: "#ApiSelect",
                    label: "form.countryLabel",
                    placeholder: "form.countryPlaceholder",
                    widgetProps: {
                        apiUrl: "/api/auxiliary/country/select",
                        cascadeClearFormFields: ["state"],
                    },
                },
            },
            {
                render: "#Field",
                props: {skipRenderWhenFormExtraTruthy: "lockStateSelect"},
                field: {
                    name: "state",
                    widget: "#ApiSelect",
                    label: "form.stateLabel",
                    placeholder: "form.statePlaceholder",
                    widgetProps: {
                        apiUrl: "/api/auxiliary/state/select",
                        postBodyFromFormField: {field: "country", paramName: "country"},
                        enableWhenFormFieldsNonEmpty: ["country"],
                        normalizeEmptyToUndefined: true,
                    },
                },
            },
        ],
    },
];

const cityEditFormNodes: ViewConfig["nodes"] = [
    {
        render: "#FormGrid",
        props: {columns: 3},
        permissions: {writeAny: ["name", "country", "state"]},
        children: [
            {
                render: "#Field",
                field: {
                    name: "name",
                    widget: "#Input",
                    label: "form.nameLabel",
                    placeholder: "form.namePlaceholder",
                    required: true,
                    widgetProps: {maxLength: CITY_NAME_MAX},
                },
                permissions: {read: "name", write: "name"},
            },
            {
                render: "#Field",
                props: {skipRenderWhenFormExtraTruthy: "lockCountrySelect"},
                field: {
                    name: "country",
                    widget: "#ApiSelect",
                    label: "form.countryLabel",
                    placeholder: "form.countryPlaceholder",
                    widgetProps: {
                        apiUrl: "/api/auxiliary/country/select",
                        cascadeClearFormFields: ["state"],
                    },
                },
                permissions: {read: "country", write: "country"},
            },
            {
                render: "#Field",
                props: {skipRenderWhenFormExtraTruthy: "lockStateSelect"},
                field: {
                    name: "state",
                    widget: "#ApiSelect",
                    label: "form.stateLabel",
                    placeholder: "form.statePlaceholder",
                    widgetProps: {
                        apiUrl: "/api/auxiliary/state/select",
                        postBodyFromFormField: {field: "country", paramName: "country"},
                        enableWhenFormFieldsNonEmpty: ["country"],
                        normalizeEmptyToUndefined: true,
                    },
                },
                permissions: {read: "state", write: "state"},
            },
        ],
    },
];

export const cityCreateFormView: ViewConfig = {
    model: "cities",
    viewType: "form",
    viewMode: "create",
    accessModel: "cities",
    apiUrl: "/api/auxiliary/city",
    method: "PUT",
    nodes: cityCreateFormNodes,
};

export const cityEditFormView: ViewConfig = {
    model: "cities",
    viewType: "form",
    viewMode: "edit",
    accessModel: "cities",
    apiUrl: "/api/auxiliary/city",
    method: "PATCH",
    nodes: cityEditFormNodes,
};

export const cityViews: ViewConfig[] = [citySheetView, cityCreateFormView, cityEditFormView];

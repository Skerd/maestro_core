import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";

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
                            render: "#SmallInfoCard",
                            dependent: "name",
                            permissions: {read: "name"},
                            field: {
                                name: "name",
                                widget: "#SmallInfoCard",
                                label: "name",
                                widgetProps: {icon: "#Tag"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            permissions: {read: "state"},
                            field: {
                                name: "state.name",
                                widget: "#SmallInfoCard",
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
                            render: "#SmallInfoCard",
                            permissions: {read: "country"},
                            field: {
                                name: "country.name",
                                widget: "#SmallInfoCard",
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
                    ]
                }
            ],
        },
    ],
};

const cityCreateFormNodes: ViewConfig["nodes"] = [
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

const cityEditFormHiddenId: ViewConfig["nodes"] = [
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

const cityEditFormNodes: ViewConfig["nodes"] = [
    ...cityEditFormHiddenId,
    {
        render: "#FormGrid",
        props: {columns: 2},
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

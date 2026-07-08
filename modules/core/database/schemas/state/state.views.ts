import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";

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
                    props: {columns: 2},
                    children: [
                        {
                            render: "#SmallInfoCard",
                            dependent: "code",
                            permissions: {read: "code"},
                            field: {
                                name: "code",
                                widget: "#SmallInfoCard",
                                label: "code",
                                widgetProps: {icon: "#Tag"},
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
                    ],
                },
            ],
        },
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

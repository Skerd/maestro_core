import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";

export const countrySheetView: ViewConfig = {
    model: "countries",
    viewType: "sheet",
    accessModel: "countries",
    apiUrl: "/api/auxiliary/country",
    header: {
        titleField: "name",
        subtitleKey: "country",
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
                            dependent: "phoneCode",
                            permissions: {read: "phoneCode"},
                            field: {
                                name: "phoneCode",
                                widget: "#SmallInfoCard",
                                label: "phoneCode",
                                widgetProps: {icon: "#Phone", prefix: "+"},
                            },
                        },
                    ],
                },
            ],
        }
    ],
};

const countryCreateFormNodes: ViewConfig["nodes"] = [
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
                field: {
                    name: "phoneCode",
                    widget: "#Input",
                    label: "form.phoneCodeLabel",
                    placeholder: "form.phoneCodePlaceholder",
                },
            },
        ],
    },
];

const countryEditFormHiddenId: ViewConfig["nodes"] = [
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

const countryEditFormNodes: ViewConfig["nodes"] = [
    ...countryEditFormHiddenId,
    {
        render: "#FormGrid",
        props: {columns: 2},
        permissions: {writeAny: ["name", "code", "phoneCode", "currency"]},
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
                field: {
                    name: "phoneCode",
                    widget: "#Input",
                    label: "form.phoneCodeLabel",
                    placeholder: "form.phoneCodePlaceholder",
                },
            },
            {
                render: "#Field",
                field: {
                    name: "currency",
                    widget: "#ApiSelect",
                    label: "form.currencyLabel",
                    placeholder: "form.currencyPlaceholder",
                    widgetProps: {apiUrl: "/api/finance/currency/select"},
                },
            },
        ],
    },
];

export const countryCreateFormView: ViewConfig = {
    model: "countries",
    viewType: "form",
    viewMode: "create",
    accessModel: "countries",
    apiUrl: "/api/auxiliary/country",
    method: "PUT",
    nodes: countryCreateFormNodes,
};

export const countryEditFormView: ViewConfig = {
    model: "countries",
    viewType: "form",
    viewMode: "edit",
    accessModel: "countries",
    apiUrl: "/api/auxiliary/country",
    method: "PATCH",
    nodes: countryEditFormNodes,
};

export const countryViews: ViewConfig[] = [
    countrySheetView,
    countryCreateFormView,
    countryEditFormView,
];

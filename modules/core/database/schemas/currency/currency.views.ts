import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";

export const currencySheetView: ViewConfig = {
    model: "currencies",
    viewType: "sheet",
    accessModel: "currencies",
    apiUrl: "/api/finance/currency",
    header: {
        titleField: "name",
        subtitleKey: "currency",
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
                            dependent: "symbol",
                            permissions: {read: "symbol"},
                            field: {
                                name: "symbol",
                                widget: "#SmallInfoCard",
                                label: "symbol",
                                widgetProps: {icon: "#CashBanknote"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            dependent: "abbreviation",
                            permissions: {read: "abbreviation"},
                            field: {
                                name: "abbreviation",
                                widget: "#SmallInfoCard",
                                label: "abbreviation",
                                widgetProps: {icon: "#Tag"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            dependent: "decimalPlaces",
                            permissions: {read: "decimalPlaces"},
                            field: {
                                name: "decimalPlaces",
                                widget: "#SmallInfoCard",
                                label: "decimalPlaces",
                                widgetProps: {icon: "#ListOrdered"},
                            },
                        },
                    ],
                },
            ],
        },
    ],
};

const currencyCreateFormNodes: ViewConfig["nodes"] = [
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
                    name: "symbol",
                    widget: "#Input",
                    label: "form.symbolLabel",
                    placeholder: "form.symbolPlaceholder",
                    required: true,
                },
            },
            {
                render: "#Field",
                field: {
                    name: "abbreviation",
                    widget: "#Input",
                    label: "form.abbreviationLabel",
                    placeholder: "form.abbreviationPlaceholder",
                    required: true,
                },
            },
            {
                render: "#Field",
                field: {
                    name: "decimalPlaces",
                    widget: "#Input",
                    label: "form.decimalPlacesLabel",
                    placeholder: "form.decimalPlacesPlaceholder",
                    required: true,
                    widgetProps: {type: "number", min: 0, max: 8, step: 1},
                },
            },
        ],
    },
];

const currencyEditFormHiddenId: ViewConfig["nodes"] = [
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

const currencyEditFormNodes: ViewConfig["nodes"] = [
    ...currencyEditFormHiddenId,
    {
        render: "#FormGrid",
        props: {columns: 2},
        permissions: {writeAny: ["name", "symbol", "abbreviation", "decimalPlaces"]},
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
                    name: "symbol",
                    widget: "#Input",
                    label: "form.symbolLabel",
                    placeholder: "form.symbolPlaceholder",
                    required: true,
                },
            },
            {
                render: "#Field",
                field: {
                    name: "abbreviation",
                    widget: "#Input",
                    label: "form.abbreviationLabel",
                    placeholder: "form.abbreviationPlaceholder",
                    required: true,
                },
            },
            {
                render: "#Field",
                field: {
                    name: "decimalPlaces",
                    widget: "#Input",
                    label: "form.decimalPlacesLabel",
                    placeholder: "form.decimalPlacesPlaceholder",
                    required: true,
                    widgetProps: {type: "number", min: 0, max: 8, step: 1},
                },
            },
        ],
    },
];

export const currencyCreateFormView: ViewConfig = {
    model: "currencies",
    viewType: "form",
    viewMode: "create",
    accessModel: "currencies",
    apiUrl: "/api/finance/currency",
    method: "PUT",
    nodes: currencyCreateFormNodes,
};

export const currencyEditFormView: ViewConfig = {
    model: "currencies",
    viewType: "form",
    viewMode: "edit",
    accessModel: "currencies",
    apiUrl: "/api/finance/currency",
    method: "PATCH",
    nodes: currencyEditFormNodes,
};

export const currencyViews: ViewConfig[] = [currencySheetView, currencyCreateFormView, currencyEditFormView];

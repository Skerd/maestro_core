import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {
    CURRENCY_ABBREVIATION_MAX,
    CURRENCY_NAME_MAX,
    CURRENCY_SYMBOL_MAX,
} from "armonia/src/modules/core/api/finance/private/currency/currency.schema-def";
import {lifecycleSheetGroup} from "../shared/lifecycleSheetGroup";

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
                            permissions: {read: "symbol"},
                            field: {
                                name: "symbol",
                                widget: "#DisplayCard",
                                label: "symbol",
                                widgetProps: {icon: "#CashBanknote"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "abbreviation"},
                            field: {
                                name: "abbreviation",
                                widget: "#DisplayCard",
                                label: "abbreviation",
                                widgetProps: {icon: "#Tag"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "decimalPlaces"},
                            field: {
                                name: "decimalPlaces",
                                widget: "#DisplayCard",
                                label: "decimalPlaces",
                                widgetProps: {icon: "#ListOrdered", type: "number"},
                            },
                        },
                    ],
                },
            ],
        },
        lifecycleSheetGroup,
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
                    widgetProps: {maxLength: CURRENCY_NAME_MAX},
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
                    widgetProps: {maxLength: CURRENCY_SYMBOL_MAX},
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
                    widgetProps: {maxLength: CURRENCY_ABBREVIATION_MAX},
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

const currencyEditFormNodes: ViewConfig["nodes"] = [
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
                    widgetProps: {maxLength: CURRENCY_NAME_MAX},
                },
                permissions: {read: "name", write: "name"},
            },
            {
                render: "#Field",
                field: {
                    name: "symbol",
                    widget: "#Input",
                    label: "form.symbolLabel",
                    placeholder: "form.symbolPlaceholder",
                    required: true,
                    widgetProps: {maxLength: CURRENCY_SYMBOL_MAX},
                },
                permissions: {read: "symbol", write: "symbol"},
            },
            {
                render: "#Field",
                field: {
                    name: "abbreviation",
                    widget: "#Input",
                    label: "form.abbreviationLabel",
                    placeholder: "form.abbreviationPlaceholder",
                    required: true,
                    widgetProps: {maxLength: CURRENCY_ABBREVIATION_MAX},
                },
                permissions: {read: "abbreviation", write: "abbreviation"},
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
                permissions: {read: "decimalPlaces", write: "decimalPlaces"},
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

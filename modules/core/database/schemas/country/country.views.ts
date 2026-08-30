import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {
    COUNTRY_CODE_MAX,
    COUNTRY_NAME_MAX,
    COUNTRY_PHONE_CODE_MAX,
} from "armonia/src/modules/core/api/auxiliary/private/country/country.schema-def";
import {lifecycleSheetGroup} from "../shared/lifecycleSheetGroup";

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
                            permissions: {read: "phoneCode"},
                            field: {
                                name: "phoneCode",
                                widget: "#DisplayCard",
                                label: "phoneCode",
                                widgetProps: {icon: "#Phone", type: "phoneCode"},
                            },
                        },
                    ],
                },
            ],
        },
        lifecycleSheetGroup,
    ],
};

const countryCreateFormNodes: ViewConfig["nodes"] = [
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
                    widgetProps: {maxLength: COUNTRY_NAME_MAX},
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
                    widgetProps: {maxLength: COUNTRY_CODE_MAX},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "phoneCode",
                    widget: "#Input",
                    label: "form.phoneCodeLabel",
                    placeholder: "form.phoneCodePlaceholder",
                    widgetProps: {maxLength: COUNTRY_PHONE_CODE_MAX},
                },
            },
        ],
    },
];

const countryEditFormNodes: ViewConfig["nodes"] = [
    {
        render: "#FormGrid",
        props: {columns: 3},
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
                    widgetProps: {maxLength: COUNTRY_NAME_MAX},
                },
                permissions: {read: "name", write: "name"},
            },
            {
                render: "#Field",
                field: {
                    name: "code",
                    widget: "#Input",
                    label: "form.codeLabel",
                    placeholder: "form.codePlaceholder",
                    required: true,
                    widgetProps: {maxLength: COUNTRY_CODE_MAX},
                },
                permissions: {write: "code", read: "code"},
            },
            {
                render: "#Field",
                field: {
                    name: "phoneCode",
                    widget: "#Input",
                    label: "form.phoneCodeLabel",
                    placeholder: "form.phoneCodePlaceholder",
                    widgetProps: {maxLength: COUNTRY_PHONE_CODE_MAX},
                },
                permissions: {read: "phoneCode", write: "phoneCode"},
            }
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

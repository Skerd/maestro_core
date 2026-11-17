import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {lifecycleSheetGroup} from "@coreModule/database/schemas/shared/lifecycleSheetGroup";

const DEFAULT_LAT = 41.3275;
const DEFAULT_LNG = 19.8189;

const userAddressTypeOptions = [
    {value: "billing", label: "form.addressType.billing"},
    {value: "shipping", label: "form.addressType.shipping"},
];

export const userAddressSheetView: ViewConfig = {
    model: "userAddresses",
    viewType: "sheet",
    sheetWidget: "#UserAddressSheetView",
    accessModel: "userAddresses",
    apiUrl: "/api/user/userAddress",
    header: {titleField: "firstName", subtitleKey: "userAddressSubtitle", showCloseButton: true},
    nodes: [
        {
            render: "#SheetGroup",
            props: {title: "overview", defaultOpen: true},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 2},
                    children: [
                        {
                            render: "#DisplayCard",
                            dependent: "user",
                            permissions: {read: "user"},
                            field: {
                                name: "user",
                                widget: "#DisplayCard",
                                label: "user",
                                widgetProps: {
                                    icon: "#IconUser",
                                    parent: "user",
                                    valuePath: ["name", "surname"],
                                    joinSeparator: " ",
                                    type: "user",
                                },
                            },
                        },
                        {
                            render: "#DisplayCard",
                            dependent: "label",
                            permissions: {read: "label"},
                            field: {
                                name: "label",
                                widget: "#DisplayCard",
                                label: "label",
                                widgetProps: {icon: "#IconTag"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            dependent: "email",
                            permissions: {read: "email"},
                            field: {
                                name: "email",
                                widget: "#DisplayCard",
                                label: "email",
                                widgetProps: {icon: "#IconMail", type: "email"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            dependent: "phone",
                            permissions: {read: "phone"},
                            field: {
                                name: "phone",
                                widget: "#DisplayCard",
                                label: "phone",
                                widgetProps: {icon: "#IconPhone", type: "phoneNumber"},
                            },
                        },
                    ],
                },
            ],
        },
        {
            render: "#SheetGroup",
            props: {title: "address", defaultOpen: true},
            permissions: {readAny: ["country", "state", "city", "street", "postalCode", "latitude", "longitude"]},
            children: [
                {
                    render: "#SheetCompanyAddresses",
                    permissions: {readAny: ["country", "state", "city", "street", "postalCode", "latitude", "longitude"]},
                    field: {
                        name: "street",
                        widget: "#SheetCompanyAddresses",
                        widgetProps: {addressField: "."},
                    },
                },
            ],
        },
        lifecycleSheetGroup,
    ],
};

const userAddressCreateFormNodes: ViewConfig["nodes"] = [
    {
        render: "#TitleWithCollapse",
        props: {title: "form.recipientSectionTitle"},
        children: [
            {
                render: "#FormGrid",
                props: {columns: 2},
                children: [
                    {
                        render: "#Field",
                        field: {
                            name: "type",
                            widget: "#SimpleSelect",
                            label: "form.typeLabel",
                            required: true,
                            widgetProps: {options: userAddressTypeOptions, className: "grow w-full"},
                        },
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "label",
                            widget: "#Input",
                            label: "form.labelLabel",
                            placeholder: "form.labelPlaceholder",
                        },
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "firstName",
                            widget: "#Input",
                            label: "form.firstNameLabel",
                            placeholder: "form.firstNamePlaceholder",
                            required: true,
                        },
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "lastName",
                            widget: "#Input",
                            label: "form.lastNameLabel",
                            placeholder: "form.lastNamePlaceholder",
                            required: true,
                        },
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "email",
                            widget: "#Input",
                            label: "form.emailLabel",
                            placeholder: "form.emailPlaceholder",
                            widgetProps: {type: "email"},
                        },
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "phone",
                            widget: "#Input",
                            label: "form.phoneLabel",
                            placeholder: "form.phonePlaceholder",
                        },
                    },
                ],
            },
        ],
    },
    {
        render: "#TitleWithCollapse",
        props: {title: "form.addressSectionTitle"},
        children: [
            {
                render: "div",
                props: {className: "grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch"},
                children: [
                    {
                        render: "div",
                        props: {className: "lg:col-span-2 space-y-6 min-w-0"},
                        children: [
                            {
                                render: "#FormGrid",
                                props: {columns: 3, className: "gap-6"},
                                children: [
                                    {
                                        render: "#Field",
                                        field: {
                                            name: "country",
                                            widget: "#ApiSelect",
                                            label: "form.countryLabel",
                                            placeholder: "form.countryPlaceholder",
                                            required: true,
                                            widgetProps: {
                                                apiUrl: "/api/auxiliary/country/select",
                                                pageSize: 50,
                                                normalizeEmptyToUndefined: true,
                                                cascadeClearFormFields: ["state", "city"],
                                            },
                                        },
                                    },
                                    {
                                        render: "#Field",
                                        field: {
                                            name: "state",
                                            widget: "#ApiSelect",
                                            label: "form.stateLabel",
                                            placeholder: "form.statePlaceholder",
                                            widgetProps: {
                                                apiUrl: "/api/auxiliary/state/select",
                                                pageSize: 50,
                                                normalizeEmptyToUndefined: true,
                                                postBodyFromFormFields: [{field: "country", paramName: "country"}],
                                                enableWhenFormFieldsNonEmpty: ["country"],
                                                cascadeClearFormFields: ["city"],
                                            },
                                        },
                                    },
                                    {
                                        render: "#Field",
                                        field: {
                                            name: "city",
                                            widget: "#ApiSelect",
                                            label: "form.cityLabel",
                                            placeholder: "form.cityPlaceholder",
                                            required: true,
                                            widgetProps: {
                                                apiUrl: "/api/auxiliary/city/select",
                                                pageSize: 50,
                                                normalizeEmptyToUndefined: true,
                                                postBodyFromFormFields: [
                                                    {field: "country", paramName: "country"},
                                                    {field: "state", paramName: "state"},
                                                ],
                                                enableWhenFormFieldsNonEmpty: ["country"],
                                            },
                                        },
                                    },
                                ],
                            },
                            {
                                render: "#FormGrid",
                                props: {columns: 2, className: "gap-6"},
                                children: [
                                    {
                                        render: "#Field",
                                        field: {
                                            name: "street",
                                            widget: "#Input",
                                            label: "form.streetLabel",
                                            placeholder: "form.streetPlaceholder",
                                            required: true,
                                        },
                                    },
                                    {
                                        render: "#Field",
                                        field: {
                                            name: "postalCode",
                                            widget: "#Input",
                                            label: "form.postalCodeLabel",
                                            placeholder: "form.postalCodePlaceholder",
                                        },
                                    },
                                ],
                            },
                            {
                                render: "#FormGrid",
                                props: {columns: 2, className: "gap-6"},
                                children: [
                                ],
                            },
                        ],
                    },
                    {
                        render: "div",
                        props: {className: "flex flex-col lg:col-span-1 w-full min-h-[220px] h-[220px] lg:h-full lg:min-h-[220px]"},
                        children: [
                            {
                                render: "#Field",
                                field: {
                                    name: "_map",
                                    widget: "#FormMapPinPicker",
                                    widgetProps: {
                                        fieldPrefix: "",
                                        latField: "latitude",
                                        lngField: "longitude",
                                        defaultLat: DEFAULT_LAT,
                                        defaultLng: DEFAULT_LNG,
                                    },
                                },
                            },
                        ],
                    },
                ],
            },
        ],
    },
];

const userAddressEditFormNodes: ViewConfig["nodes"] = [
    {
        render: "#TitleWithCollapse",
        props: {title: "form.recipientSectionTitle"},
        permissions: {
            readAny: ["type", "label", "firstName", "lastName", "email", "phone"],
            writeAny: ["type", "label", "firstName", "lastName", "email", "phone"],
        },
        children: [
            {
                render: "#FormGrid",
                props: {columns: 2},
                children: [
                    {
                        render: "#Field",
                        permissions: {read: "type", write: "type"},
                        field: {
                            name: "type",
                            widget: "#SimpleSelect",
                            label: "form.typeLabel",
                            required: true,
                            widgetProps: {options: userAddressTypeOptions, className: "grow w-full"},
                        },
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "label",
                            widget: "#Input",
                            label: "form.labelLabel",
                            placeholder: "form.labelPlaceholder",
                        }, permissions: {read: "label", write: "label"},
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "firstName",
                            widget: "#Input",
                            label: "form.firstNameLabel",
                            placeholder: "form.firstNamePlaceholder",
                            required: true,
                        }, permissions: {read: "firstName", write: "firstName"},
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "lastName",
                            widget: "#Input",
                            label: "form.lastNameLabel",
                            placeholder: "form.lastNamePlaceholder",
                            required: true,
                        }, permissions: {read: "lastName", write: "lastName"},
                    },
                    {
                        render: "#Field",
                        permissions: {read: "email", write: "email"},
                        field: {
                            name: "email",
                            widget: "#Input",
                            label: "form.emailLabel",
                            placeholder: "form.emailPlaceholder",
                            widgetProps: {type: "email"},
                        },
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "phone",
                            widget: "#Input",
                            label: "form.phoneLabel",
                            placeholder: "form.phonePlaceholder",
                        }, permissions: {read: "phone", write: "phone"},
                    },
                ],
            },
        ],
    },
    {
        render: "#TitleWithCollapse",
        props: {title: "form.addressSectionTitle"},
        permissions: {
            readAny: ["country", "state", "city", "street", "postalCode", "latitude", "longitude"],
            writeAny: ["country", "state", "city", "street", "postalCode", "latitude", "longitude"],
        },
        children: [
            {
                render: "div",
                props: {className: "grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch"},
                children: [
                    {
                        render: "div",
                        props: {className: "lg:col-span-2 space-y-6 min-w-0"},
                        children: [
                            {
                                render: "#FormGrid",
                                props: {columns: 3, className: "gap-6"},
                                children: [
                                    {
                                        render: "#Field",
                                        field: {
                                            name: "country",
                                            widget: "#ApiSelect",
                                            label: "form.countryLabel",
                                            placeholder: "form.countryPlaceholder",
                                            required: true,
                                            widgetProps: {
                                                apiUrl: "/api/auxiliary/country/select",
                                                pageSize: 50,
                                                normalizeEmptyToUndefined: true,
                                                cascadeClearFormFields: ["state", "city"],
                                            },
                                        }, permissions: {read: "country", write: "country"},
                                    },
                                    {
                                        render: "#Field",
                                        field: {
                                            name: "state",
                                            widget: "#ApiSelect",
                                            label: "form.stateLabel",
                                            placeholder: "form.statePlaceholder",
                                            widgetProps: {
                                                apiUrl: "/api/auxiliary/state/select",
                                                pageSize: 50,
                                                normalizeEmptyToUndefined: true,
                                                postBodyFromFormFields: [{field: "country", paramName: "country"}],
                                                enableWhenFormFieldsNonEmpty: ["country"],
                                                cascadeClearFormFields: ["city"],
                                            },
                                        }, permissions: {read: "state", write: "state"},
                                    },
                                    {
                                        render: "#Field",
                                        field: {
                                            name: "city",
                                            widget: "#ApiSelect",
                                            label: "form.cityLabel",
                                            placeholder: "form.cityPlaceholder",
                                            required: true,
                                            widgetProps: {
                                                apiUrl: "/api/auxiliary/city/select",
                                                pageSize: 50,
                                                normalizeEmptyToUndefined: true,
                                                postBodyFromFormFields: [
                                                    {field: "country", paramName: "country"},
                                                    {field: "state", paramName: "state"},
                                                ],
                                                enableWhenFormFieldsNonEmpty: ["country"],
                                            },
                                        }, permissions: {read: "city", write: "city"},
                                    },
                                ],
                            },
                            {
                                render: "#FormGrid",
                                props: {columns: 2, className: "gap-6"},
                                children: [
                                    {
                                        render: "#Field",
                                        field: {
                                            name: "street",
                                            widget: "#Input",
                                            label: "form.streetLabel",
                                            placeholder: "form.streetPlaceholder",
                                            required: true,
                                        }, permissions: {read: "street", write: "street"},
                                    },
                                    {
                                        render: "#Field",
                                        field: {
                                            name: "postalCode",
                                            widget: "#Input",
                                            label: "form.postalCodeLabel",
                                            placeholder: "form.postalCodePlaceholder",
                                        }, permissions: {read: "postalCode", write: "postalCode"},
                                    },
                                ],
                            },
                            {
                                render: "#FormGrid",
                                props: {columns: 2, className: "gap-6"},
                                children: [
                                ],
                            },
                        ],
                    },
                    {
                        render: "div",
                        props: {className: "flex flex-col lg:col-span-1 w-full min-h-[220px] h-[220px] lg:h-full lg:min-h-[220px]"},
                        children: [
                            {
                                render: "#Field",
                                field: {
                                    name: "_map",
                                    widget: "#FormMapPinPicker",
                                    skipWriteAccessGate: true,
                                    widgetProps: {
                                        fieldPrefix: "",
                                        latField: "latitude",
                                        lngField: "longitude",
                                        defaultLat: DEFAULT_LAT,
                                        defaultLng: DEFAULT_LNG,
                                    },
                                },
                            },
                        ],
                    },
                ],
            },
        ],
    },
];

export const userAddressCreateFormView: ViewConfig = {
    model: "userAddresses",
    viewType: "form",
    viewMode: "create",
    accessModel: "userAddresses",
    apiUrl: "/api/user/userAddress",
    method: "PUT",
    nodes: userAddressCreateFormNodes,
};

export const userAddressEditFormView: ViewConfig = {
    model: "userAddresses",
    viewType: "form",
    viewMode: "edit",
    accessModel: "userAddresses",
    apiUrl: "/api/user/userAddress",
    method: "PATCH",
    nodes: userAddressEditFormNodes,
};

export const userAddressViews: ViewConfig[] = [
    userAddressSheetView,
    userAddressCreateFormView,
    userAddressEditFormView,
];

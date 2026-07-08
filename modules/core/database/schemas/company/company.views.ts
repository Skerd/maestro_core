import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";

export const companySheetView: ViewConfig = {
    model: "companies",
    viewType: "sheet",
    accessModel: "companies",
    apiUrl: "/api/company",
    header: {
        titleField: "name",
        subtitleKey: "company",
        showCloseButton: true
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
                            permissions: {read: "email"},
                            field: {name: "email", widget: "#SmallInfoCard", label: "email", widgetProps: {icon: "#Mail"}},
                        },
                        {
                            render: "#SmallInfoCard",
                            permissions: {read: "phoneNumber"},
                            field: {name: "phoneNumber", widget: "#SmallInfoCard", label: "phone", widgetProps: {icon: "#Phone"}},
                        },
                        {
                            render: "#SmallInfoCard",
                            permissions: {read: "website"},
                            field: {name: "website", widget: "#SmallInfoCard", label: "website", widgetProps: {icon: "#World"}},
                        },
                        {
                            render: "#SmallInfoCard",
                            permissions: {read: "vat"},
                            field: {name: "vat", widget: "#SmallInfoCard", label: "vat", widgetProps: {icon: "#Hash"}},
                        },
                        {
                            render: "#SmallInfoCard",
                            permissions: {read: "parentCompany"},
                            field: {
                                name: "parentCompany",
                                widget: "#SmallInfoCard",
                                label: "parentCompany",
                                widgetProps: {icon: "#Building", parent: "parentCompany", valuePath: ["name", "vat"], joinSeparator: " - "},
                            },
                        },
                    ],
                },
            ],
        },
        {
            render: "#SheetGroup",
            props: {title: "allowedDomains"},
            permissions: {read: "allowedDomains"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 1},
                    children: [
                        {
                            render: "#SmallInfoCard",
                            permissions: {read: "allowedDomains"},
                            field: {
                                name: "allowedDomains",
                                widget: "#SmallInfoCard",
                                label: "allowedDomains",
                                widgetProps: {icon: "#WorldCheck", valueType: "stringBadgeList"},
                            },
                        },
                    ],
                },
            ],
        },
        {
            render: "#SheetGroup",
            props: {title: "howToReach"},
            dependent: "addresses",
            permissions: {read: "addresses"},
            children: [
                {
                    render: "#SheetCompanyAddresses",
                    permissions: {read: "addresses"},
                    field: {
                        name: "addresses",
                        widget: "#SheetCompanyAddresses",
                    },
                },
            ],
        },
        {
            render: "#SheetGroup",
            props: {title: "whoAreWe"},
            permissions: {read: "description"},
            children: [
                {
                    render: "div",
                    props: { className: "p-2 rounded-lg bg-muted/30 border border-border/50" },
                    children: [
                        {
                            render: "#ExpandableText",
                            permissions: { read: "description" },
                            field: {
                                name: "description",
                                widget: "#ExpandableText",
                                widgetProps: { className: "text-sm" },
                            },
                        },
                    ],
                },
            ],
        },
        {
            render: "#SheetGroup",
            props: {title: "logo"},
            permissions: {read: "logo"},
            children: [
                {
                    render: "div",
                    props: {className: "p-2 rounded-lg bg-muted/30 border border-border/50 max-w-full"},
                    permissions: {read: "logo"},
                    children: [
                        {
                            render: "#SheetMediaAvatar",
                            permissions: {read: "logo"},
                            field: {
                                name: "logo",
                                widget: "#SheetMediaAvatar",
                                widgetProps: {
                                    nameField: "name",
                                },
                            },
                        },
                    ],
                },
            ],
        },
    ],
};

const companyFormCreateFields: ViewConfig["nodes"] = [
    {
        render: "#FormGrid",
        props: {columns: 1, className: "px-1"},
        children: [
            {render: "#Field", field: {name: "name", widget: "#Input", label: "form.nameLabel", placeholder: "form.namePlaceholder", required: true}},
            {render: "#Field", field: {name: "vat", widget: "#Input", label: "form.vatLabel", placeholder: "form.vatPlaceholder", required: true}},
            {
                render: "#Field",
                field: {
                    name: "logo",
                    widget: "#MediaField",
                    label: "form.logoLabel",
                    widgetProps: {mediaType: "image", mode: "single", onDialog: true},
                },
            },
        ],
    },
];

const companyFormEditFields: ViewConfig["nodes"] = [
    {
        render: "#TitleWithCollapse",
        props: {title: "generalInfo"},
        permissions: {writeAny: ["name", "email", "phoneNumber", "website", "allowedDomains", "vat"]},
        children: [
            {
                render: "#FormGrid",
                props: {columns: 2},
                children: [
                    {render: "#Field", field: {name: "name", widget: "#Input", label: "form.nameLabel", placeholder: "form.namePlaceholder", required: true}},
                    {render: "#Field", field: {name: "email", widget: "#Input", label: "form.emailLabel", placeholder: "form.emailPlaceholder", required: true}},
                    {
                        render: "#Field",
                        field: {
                            name: "phoneNumber",
                            widget: "#PhoneInput",
                            label: "form.phoneNumberNumberLabel",
                            placeholder: "form.phoneNumberNumberPlaceholder",
                            required: true,
                            widgetProps: {defaultCountry: "AL"},
                        },
                    },
                    {render: "#Field", field: {name: "website", widget: "#Input", label: "form.websiteLabel", placeholder: "form.websitePlaceholder"}},
                    {render: "#Field", field: {name: "vat", widget: "#Input", label: "form.vatLabel", placeholder: "form.vatPlaceholder", required: true}},
                    {
                        render: "div",
                        props: {className: "md:col-span-2"},
                        children: [
                            {
                                render: "#Field",
                                field: {
                                    name: "allowedDomains",
                                    widget: "#StringArrayField",
                                    label: "form.allowedDomainsLabel",
                                    placeholder: "form.allowedDomainsPlaceholder",
                                    widgetProps: {removeTooltipKey: "remove"},
                                },
                            },
                        ],
                    },
                ],
            },
        ],
    },
    {
        render: "#Field",
        permissions: {write: "addresses"},
        field: {
            name: "addresses",
            widget: "#FormRepeater",
            widgetProps: {
                title: "howToReach",
                arrayField: "addresses",
                deleteField: "deleteAddresses",
                defaultItem: {
                    street: "",
                    postalCode: "",
                    city: "",
                    state: undefined,
                    country: "",
                    latitude: 41.3275,
                    longitude: 19.8189,
                },
                addLabel: "addAddress",
                removeLabel: "remove",
                rowTitleFields: ["street", "city", "state", "country", "postalCode"],
                rowTitlePlaceholder: "address",
                rowTemplate: [
                    {
                        render: "div",
                        props: {className: "grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch"},
                        children: [
                            {
                                render: "div",
                                props: {className: "lg:col-span-2 space-y-4 min-w-0"},
                                children: [
                                    {
                                        render: "#FormGrid",
                                        props: {columns: 3},
                                        children: [
                                            {
                                                render: "#Field",
                                                field: {
                                                    name: "country",
                                                    widget: "#ApiSelect",
                                                    label: "form.countryLabel",
                                                    placeholder: "form.countryPlaceholder",
                                                    widgetProps: {
                                                        apiUrl: "/api/auxiliary/country/select",
                                                        method: "POST",
                                                        pageSize: 50,
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
                                                        method: "POST",
                                                        pageSize: 50,
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
                                                    widgetProps: {
                                                        apiUrl: "/api/auxiliary/city/select",
                                                        method: "POST",
                                                        pageSize: 50,
                                                        postBodyFromFormFields: [{field: "country", paramName: "country"}, {field: "state", paramName: "state"}],
                                                        enableWhenFormFieldsNonEmpty: ["country"],
                                                    },
                                                },
                                            },
                                        ],
                                    },
                                    {
                                        render: "#FormGrid",
                                        props: {columns: 2},
                                        children: [
                                            {
                                                render: "#Field",
                                                field: {name: "street", widget: "#Input", label: "form.streetLabel", placeholder: "form.streetPlaceholder"},
                                            },
                                            {
                                                render: "#Field",
                                                field: {name: "postalCode", widget: "#Input", label: "form.postalCodeLabel", placeholder: "form.postalCodePlaceholder"},
                                            },
                                        ],
                                    },
                                    {
                                        render: "#FormGrid",
                                        props: {columns: 2},
                                        children: [
                                            {
                                                render: "#Field",
                                                field: {name: "latitude", widget: "#Input", label: "form.latitudeLabel", placeholder: "form.latitudePlaceholder", widgetProps: {type: "number", step: "0.000001"}},
                                            },
                                            {
                                                render: "#Field",
                                                field: {name: "longitude", widget: "#Input", label: "form.longitudeLabel", placeholder: "form.longitudePlaceholder", widgetProps: {type: "number", step: "0.000001"}},
                                            },
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
                                            widgetProps: {latField: "latitude", lngField: "longitude", defaultLat: 41.3275, defaultLng: 19.8189},
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        },
    },
    {
        render: "#TitleWithCollapse",
        props: {title: "whoAreWe"},
        permissions: {writeAny: ["description", "logo"]},
        children: [
            {
                render: "#FormGrid",
                props: {columns: 1},
                children: [
                    {
                        render: "#Field",
                        field: {
                            name: "description",
                            widget: "#Textarea",
                            label: "form.descriptionLabel",
                            placeholder: "form.descriptionPlaceholder",
                            widgetProps: {className: "resize-none max-h-[250px] overflow-y-auto"},
                        },
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "logo",
                            widget: "#MediaField",
                            label: "form.logoLabel",
                            widgetProps: {mediaType: "image", mode: "single"},
                        },
                    },
                ],
            },
        ],
    },
];

export const companyCreateFormView: ViewConfig = {
    model: "companies",
    viewType: "form",
    viewMode: "create",
    accessModel: "companies",
    apiUrl: "/api/company",
    method: "PUT",
    nodes: companyFormCreateFields,
};

export const companyEditFormView: ViewConfig = {
    model: "companies",
    viewType: "form",
    viewMode: "edit",
    accessModel: "companies",
    apiUrl: "/api/company",
    method: "PATCH",
    nodes: companyFormEditFields,
};

export const companyViews: ViewConfig[] = [
    companySheetView,
    companyCreateFormView,
    companyEditFormView,
];

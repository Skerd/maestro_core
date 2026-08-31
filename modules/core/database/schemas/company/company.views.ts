import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {lifecycleSheetGroup} from "@coreModule/database/schemas/shared/lifecycleSheetGroup";

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
                            render: "#DisplayCard",
                            permissions: {read: "email"},
                            field: {name: "email", widget: "#DisplayCard", label: "email", widgetProps: {icon: "#Mail"}},
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "phoneNumber"},
                            field: {name: "phoneNumber", widget: "#DisplayCard", label: "phone", widgetProps: {icon: "#Phone"}},
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "website"},
                            field: {name: "website", widget: "#DisplayCard", label: "website", widgetProps: {icon: "#World", externalLink: true}},
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "linkedin"},
                            field: {name: "linkedin", widget: "#DisplayCard", label: "linkedin", widgetProps: {icon: "#World", externalLink: true}},
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "instagram"},
                            field: {name: "instagram", widget: "#DisplayCard", label: "instagram", widgetProps: {icon: "#World", externalLink: true}},
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "facebook"},
                            field: {name: "facebook", widget: "#DisplayCard", label: "facebook", widgetProps: {icon: "#World", externalLink: true}},
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "vat"},
                            field: {name: "vat", widget: "#DisplayCard", label: "vat", widgetProps: {icon: "#Hash"}},
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "parentCompany"},
                            field: {
                                name: "parentCompany",
                                widget: "#DisplayCard",
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
                            render: "#DisplayCard",
                            permissions: {read: "allowedDomains"},
                            field: {
                                name: "allowedDomains",
                                widget: "#DisplayCard",
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
        {
            render: "#SheetGroup",
            props: {title: "publicAiChat"},
            permissions: {read: "publicAiChat"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 3},
                    children: [
                        {
                            render: "#DisplayCard",
                            permissions: {read: "publicAiChat"},
                            field: {
                                name: "publicAiChat.enabled",
                                widget: "#DisplayCard",
                                label: "enabled",
                                widgetProps: {icon: "#IconToggleRight", valueType: "boolean"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "publicAiChat"},
                            field: {
                                name: "publicAiChat.requireIdentification",
                                widget: "#DisplayCard",
                                label: "requireIdentification",
                                widgetProps: {icon: "#IconId", valueType: "boolean"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "publicAiChat"},
                            field: {
                                name: "publicAiChat.humanHandoffEnabled",
                                widget: "#DisplayCard",
                                label: "humanHandoffEnabled",
                                widgetProps: {icon: "#IconUsers", valueType: "boolean"},
                            },
                        },
                    ],
                },
                {
                    render: "#SheetGroup",
                    props: {title: "greeting", collapsible: false},
                    permissions: {read: "publicAiChat"},
                    children: [
                        {
                            render: "div",
                            props: {className: "p-2 rounded-lg bg-muted/30 border border-border/50"},
                            children: [
                                {
                                    render: "#ExpandableText",
                                    permissions: {read: "publicAiChat"},
                                    field: {
                                        name: "publicAiChat.greeting",
                                        widget: "#ExpandableText",
                                        widgetProps: {className: "text-sm"},
                                    },
                                },
                            ],
                        },
                    ],
                },
                {
                    render: "#SheetGroup",
                    props: {title: "persona", collapsible: false},
                    permissions: {read: "publicAiChat"},
                    children: [
                        {
                            render: "div",
                            props: {className: "p-2 rounded-lg bg-muted/30 border border-border/50"},
                            children: [
                                {
                                    render: "#ExpandableText",
                                    permissions: {read: "publicAiChat"},
                                    field: {
                                        name: "publicAiChat.persona",
                                        widget: "#ExpandableText",
                                        widgetProps: {className: "text-sm"},
                                    },
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        lifecycleSheetGroup,
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
        permissions: {writeAny: ["name", "email", "phoneNumber", "website", "linkedin", "instagram", "facebook", "allowedDomains", "vat"]},
        children: [
            {
                render: "#FormGrid",
                props: {columns: 2},
                children: [
                    {render: "#Field", field: {name: "name", widget: "#Input", label: "form.nameLabel", placeholder: "form.namePlaceholder", required: true}, permissions: {read: "name", write: "name"}},
                    {render: "#Field", field: {name: "email", widget: "#Input", label: "form.emailLabel", placeholder: "form.emailPlaceholder", required: true}, permissions: {read: "email", write: "email"}},
                    {
                        render: "#Field",
                        field: {
                            name: "phoneNumber",
                            widget: "#PhoneInput",
                            label: "form.phoneNumberNumberLabel",
                            placeholder: "form.phoneNumberNumberPlaceholder",
                            required: true,
                            widgetProps: {defaultCountry: "AL"},
                        }, permissions: {read: "phoneNumber", write: "phoneNumber"},
                    },
                    {render: "#Field", field: {name: "website", widget: "#Input", label: "form.websiteLabel", placeholder: "form.websitePlaceholder"}, permissions: {read: "website", write: "website"}},
                    {render: "#Field", field: {name: "linkedin", widget: "#Input", label: "form.linkedinLabel", placeholder: "form.linkedinPlaceholder"}, permissions: {read: "linkedin", write: "linkedin"}},
                    {render: "#Field", field: {name: "instagram", widget: "#Input", label: "form.instagramLabel", placeholder: "form.instagramPlaceholder"}, permissions: {write: "instagram", read: "instagram"}},
                    {render: "#Field", field: {name: "facebook", widget: "#Input", label: "form.facebookLabel", placeholder: "form.facebookPlaceholder"}, permissions: {read: "facebook", write: "facebook"}},
                    {render: "#Field", field: {name: "vat", widget: "#Input", label: "form.vatLabel", placeholder: "form.vatPlaceholder", required: true}, permissions: {read: "vat", write: "vat"}},
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
                                }, permissions: {read: "allowedDomains", write: "allowedDomains"},
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
                                        props: {columns: 2, className: "gap-6"},
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
                                        props: {columns: 2, className: "gap-6"},
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
                        permissions: {read: "description", write: "description"},
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "logo",
                            widget: "#MediaField",
                            label: "form.logoLabel",
                            widgetProps: {mediaType: "image", mode: "single"},
                        },
                        permissions: {read: "logo", write: "logo"},
                    },
                ],
            },
        ],
    },
    {
        render: "#TitleWithCollapse",
        props: {title: "publicAiChat"},
        permissions: {write: "publicAiChat"},
        children: [
            {
                render: "#FormGrid",
                props: {columns: 1},
                children: [
                    {
                        render: "#Field",
                        field: {
                            name: "publicAiChat.enabled",
                            widget: "#Switch",
                            label: "form.enabledLabel"
                        },
                        permissions: {read: "publicAiChat.enabled", write: "publicAiChat.enabled"}
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "publicAiChat.requireIdentification",
                            widget: "#Switch",
                            label: "form.requireIdentificationLabel"
                        },
                        permissions: {read: "publicAiChat.requireIdentification", write: "publicAiChat.requireIdentification"}
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "publicAiChat.humanHandoffEnabled",
                            widget: "#Switch",
                            label: "form.humanHandoffEnabledLabel"
                        },
                        permissions: {read: "publicAiChat.humanHandoffEnabled", write: "publicAiChat.humanHandoffEnabled"}
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "publicAiChat.greeting",
                            widget: "#Textarea",
                            label: "form.greetingLabel",
                            placeholder: "form.greetingPlaceholder",
                            widgetProps: {className: "resize-none max-h-[160px] overflow-y-auto"},
                        },
                        permissions: {write: "publicAiChat.greeting", read: "publicAiChat.greeting"},
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "publicAiChat.persona",
                            widget: "#Textarea",
                            label: "form.personaLabel",
                            placeholder: "form.personaPlaceholder",
                            widgetProps: {className: "resize-none max-h-[250px] overflow-y-auto"},
                        },
                        permissions: {read: "publicAiChat.persona", write: "publicAiChat.persona"},
                    },
                ],
            },
        ],
    }
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

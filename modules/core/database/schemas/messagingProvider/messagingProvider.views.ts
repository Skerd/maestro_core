import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {
    MESSAGING_PROVIDER_ACCOUNT_SID_MAX,
    MESSAGING_PROVIDER_NAME_MAX,
    MESSAGING_PROVIDER_PHONE_MAX,
} from "armonia/src/modules/core/api/auxiliary/private/messagingProvider/messagingProvider.schema-def";
import {lifecycleSheetGroup} from "../shared/lifecycleSheetGroup";

export const messagingProviderSheetView: ViewConfig = {
    model: "messagingProviders",
    viewType: "sheet",
    accessModel: "messagingProviders",
    apiUrl: "/api/auxiliary/messagingProvider",
    header: {
        titleField: "name",
        subtitleKey: "providerType",
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
                            dependent: "name",
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
                            dependent: "providerType",
                            permissions: {read: "providerType"},
                            field: {
                                name: "providerType",
                                widget: "#DisplayCard",
                                label: "providerType",
                                widgetProps: {icon: "#MessageSquare", languageKeyCategory: "providerTypeValues", type: "enum"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            dependent: "active",
                            permissions: {read: "active"},
                            field: {
                                name: "active",
                                widget: "#DisplayCard",
                                label: "active",
                                widgetProps: {icon: "#Power", type: "boolean"},
                            },
                        },
                    ],
                },
            ],
        },
        {
            render: "#SheetGroup",
            props: {title: "credentials"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 2},
                    children: [
                        {
                            render: "#DisplayCard",
                            dependent: "accountSid",
                            permissions: {read: "accountSid"},
                            field: {
                                name: "accountSid",
                                widget: "#DisplayCard",
                                label: "accountSid",
                                widgetProps: {icon: "#Key"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            dependent: "hasAuthToken",
                            permissions: {read: "accountSid"},
                            field: {
                                name: "hasAuthToken",
                                widget: "#DisplayCard",
                                label: "hasAuthToken",
                                widgetProps: {icon: "#Lock", type: "boolean"},
                            },
                        },
                    ],
                },
            ],
        },
        {
            render: "#SheetGroup",
            props: {title: "senders"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 2},
                    children: [
                        {
                            render: "#DisplayCard",
                            dependent: "fromPhone",
                            permissions: {read: "fromPhone"},
                            field: {
                                name: "fromPhone",
                                widget: "#DisplayCard",
                                label: "fromPhone",
                                widgetProps: {icon: "#Phone", type: "phoneNumber"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            dependent: "fromWhatsapp",
                            permissions: {read: "fromWhatsapp"},
                            field: {
                                name: "fromWhatsapp",
                                widget: "#DisplayCard",
                                label: "fromWhatsapp",
                                widgetProps: {icon: "#BrandWhatsapp", type: "phoneNumber"},
                            },
                        },
                    ],
                },
            ],
        },
        {
            render: "#SheetGroup",
            props: {title: "lastTest"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 3},
                    children: [
                        {
                            render: "#DisplayCard",
                            permissions: {read: "lastTestStatus"},
                            field: {
                                name: "lastTestStatus",
                                widget: "#DisplayCard",
                                label: "lastTestStatus",
                                widgetProps: {
                                    icon: "#CircleDot",
                                    languageKeyCategory: "lastTestStatusValues", type: "enum",
                                    variantLookupField: "lastTestStatus",
                                    variantLookupMap: {ok: "success", failed: "destructive"},
                                },
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "lastTestedAt"},
                            field: {
                                name: "lastTestedAt",
                                widget: "#DisplayCard",
                                label: "lastTestedAt",
                                widgetProps: {icon: "#Calendar", type: "dateTime"},
                            },
                        },
                    ],
                },
                {
                    render: "#SheetGrid",
                    props: {columns: 1},
                    children: [
                        {
                            render: "#DisplayCard",
                            permissions: {read: "lastTestMessage"},
                            dependent: "lastTestMessage",
                            field: {
                                name: "lastTestMessage",
                                widget: "#DisplayCard",
                                label: "lastTestMessage",
                                widgetProps: {
                                    icon: "#IconAlignLeft",
                                    expandable: true,
                                    maxLength: 250,
                                },
                            },
                        },
                    ],
                },
            ],
        },
        lifecycleSheetGroup,
    ],
};

const messagingProviderFormFields: ViewConfig["nodes"] = [
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
                    widgetProps: {maxLength: MESSAGING_PROVIDER_NAME_MAX},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "providerType",
                    widget: "#SimpleSelect",
                    label: "form.providerTypeLabel",
                    required: true,
                    widgetProps: {
                        options: [{value: "twilio", label: "form.providerType.twilio"}],
                        className: "grow w-full",
                    },
                },
            },
            {
                render: "#Field",
                field: {
                    name: "accountSid",
                    widget: "#Input",
                    label: "form.accountSidLabel",
                    placeholder: "form.accountSidPlaceholder",
                    required: true,
                    widgetProps: {maxLength: MESSAGING_PROVIDER_ACCOUNT_SID_MAX},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "authToken",
                    widget: "#Input",
                    label: "form.authTokenLabel",
                    placeholder: "form.authTokenPlaceholder",
                    required: true,
                    skipWriteAccessGate: true,
                    widgetProps: {type: "password", autoComplete: "new-password"},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "fromPhone",
                    widget: "#Input",
                    label: "form.fromPhoneLabel",
                    placeholder: "form.fromPhonePlaceholder",
                    widgetProps: {type: "tel", maxLength: MESSAGING_PROVIDER_PHONE_MAX},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "fromWhatsapp",
                    widget: "#Input",
                    label: "form.fromWhatsappLabel",
                    placeholder: "form.fromWhatsappPlaceholder",
                    widgetProps: {type: "tel", maxLength: MESSAGING_PROVIDER_PHONE_MAX},
                },
            },
        ],
    },
];

export const messagingProviderCreateFormView: ViewConfig = {
    model: "messagingProviders",
    viewType: "form",
    viewMode: "create",
    accessModel: "messagingProviders",
    apiUrl: "/api/auxiliary/messagingProvider",
    method: "PUT",
    nodes: messagingProviderFormFields,
};

export const messagingProviderEditFormView: ViewConfig = {
    model: "messagingProviders",
    viewType: "form",
    viewMode: "edit",
    accessModel: "messagingProviders",
    apiUrl: "/api/auxiliary/messagingProvider",
    method: "PATCH",
    nodes: messagingProviderFormFields.map((node) => {
        if (node.render !== "#FormGrid" || !node.children) return node;
        return {
            ...node,
            children: node.children.map((child) => {
                if (child.field?.name !== "authToken") return child;
                return {
                    ...child,
                    field: {
                        ...child.field,
                        label: "form.authTokenEditLabel",
                        placeholder: "form.authTokenEditPlaceholder",
                        required: false,
                    },
                };
            }),
        };
    }),
};

export const messagingProviderViews: ViewConfig[] = [
    messagingProviderSheetView,
    messagingProviderCreateFormView,
    messagingProviderEditFormView,
];

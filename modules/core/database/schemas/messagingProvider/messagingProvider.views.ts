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

const messagingProviderCreateFormNode: ViewConfig["nodes"] = [
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
                field: {name: "authTokenEncrypted", widget: "#Input", label: "form.authTokenEncryptedLabel", placeholder: "form.authTokenEncryptedPlaceholder", required: true, widgetProps: {type: "password", autoComplete: "new-password"}},
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

const messagingProviderEditFormNode: ViewConfig["nodes"] = [
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
                permissions: {read: "name", write: "name"},
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
                permissions: {read: "providerType", write: "providerType"},
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
                permissions: {read: "accountSid", write: "accountSid"},
            },
            {
                render: "#Field",
                field: {
                    name: "authTokenEncrypted",
                    widget: "#Input",
                    label: "form.authTokenEncryptedLabel",
                    placeholder: "form.authTokenEncryptedPlaceholder",
                    required: false,
                    widgetProps: {
                        type: "password",
                        autoComplete: "new-password"
                    }
                },
                permissions: {write: "authTokenEncrypted"},
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
                permissions: {read: "fromPhone", write: "fromPhone"},
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
                permissions: {write: "fromWhatsapp", read: "fromWhatsapp"},
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
    nodes: messagingProviderCreateFormNode,
};

export const messagingProviderEditFormView: ViewConfig = {
    model: "messagingProviders",
    viewType: "form",
    viewMode: "edit",
    accessModel: "messagingProviders",
    apiUrl: "/api/auxiliary/messagingProvider",
    method: "PATCH",
    nodes: messagingProviderEditFormNode
};

export const messagingProviderViews: ViewConfig[] = [
    messagingProviderSheetView,
    messagingProviderCreateFormView,
    messagingProviderEditFormView,
];

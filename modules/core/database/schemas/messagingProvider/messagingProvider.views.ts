import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
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
                    props: {columns: 2},
                    children: [
                        {
                            render: "#SmallInfoCard",
                            dependent: "providerType",
                            permissions: {read: "providerType"},
                            field: {
                                name: "providerType",
                                widget: "#SmallInfoCard",
                                label: "providerType",
                                widgetProps: {icon: "#MessageSquare", languageKeyCategory: "providerTypeValues"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            dependent: "active",
                            permissions: {read: "active"},
                            field: {
                                name: "active",
                                widget: "#SmallInfoCard",
                                label: "active",
                                widgetProps: {icon: "#Power", valueType: "boolean"},
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
                            render: "#SmallInfoCard",
                            dependent: "accountSid",
                            permissions: {read: "accountSid"},
                            field: {
                                name: "accountSid",
                                widget: "#SmallInfoCard",
                                label: "accountSid",
                                widgetProps: {icon: "#Key"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            dependent: "hasAuthToken",
                            permissions: {read: "accountSid"},
                            field: {
                                name: "hasAuthToken",
                                widget: "#SmallInfoCard",
                                label: "hasAuthToken",
                                widgetProps: {icon: "#Lock", valueType: "boolean"},
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
                            render: "#SmallInfoCard",
                            dependent: "fromPhone",
                            permissions: {read: "fromPhone"},
                            field: {
                                name: "fromPhone",
                                widget: "#SmallInfoCard",
                                label: "fromPhone",
                                widgetProps: {icon: "#Phone"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            dependent: "fromWhatsapp",
                            permissions: {read: "fromWhatsapp"},
                            field: {
                                name: "fromWhatsapp",
                                widget: "#SmallInfoCard",
                                label: "fromWhatsapp",
                                widgetProps: {icon: "#BrandWhatsapp"},
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
                    props: {columns: 2},
                    children: [
                        {
                            render: "#SmallInfoCard",
                            permissions: {read: "lastTestStatus"},
                            field: {
                                name: "lastTestStatus",
                                widget: "#SmallInfoCard",
                                label: "lastTestStatus",
                                widgetProps: {
                                    icon: "#CircleDot",
                                    languageKeyCategory: "lastTestStatusValues",
                                    variantLookupField: "lastTestStatus",
                                    variantLookupMap: {ok: "success", failed: "destructive"},
                                },
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            permissions: {read: "lastTestedAt"},
                            field: {
                                name: "lastTestedAt",
                                widget: "#SmallInfoCard",
                                label: "lastTestedAt",
                                widgetProps: {icon: "#Clock", format: "dateTime"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            permissions: {read: "lastTestMessage"},
                            field: {
                                name: "lastTestMessage",
                                widget: "#SmallInfoCard",
                                label: "lastTestMessage",
                                widgetProps: {icon: "#MessageSquare"},
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
                    widgetProps: {type: "tel"},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "fromWhatsapp",
                    widget: "#Input",
                    label: "form.fromWhatsappLabel",
                    placeholder: "form.fromWhatsappPlaceholder",
                    widgetProps: {type: "tel"},
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

import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";

export const smtpServerSheetView: ViewConfig = {
    model: "smtpServers",
    viewType: "sheet",
    accessModel: "smtpServers",
    apiUrl: "/api/auxiliary/smtpServer",
    header: {
        titleField: "name",
        subtitleKey: "host",
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
                            dependent: "sequence",
                            field: {
                                name: "sequence",
                                widget: "#SmallInfoCard",
                                label: "sequence",
                                widgetProps: {icon: "#ListOrdered"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            dependent: "active",
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
            props: {title: "connection"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 2},
                    children: [
                        {
                            render: "#SmallInfoCard",
                            dependent: "host",
                            field: {
                                name: "host",
                                widget: "#SmallInfoCard",
                                label: "host",
                                widgetProps: {icon: "#Server"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            dependent: "port",
                            field: {
                                name: "port",
                                widget: "#SmallInfoCard",
                                label: "port",
                                widgetProps: {icon: "#Plug"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            dependent: "encryption",
                            field: {
                                name: "encryption",
                                widget: "#SmallInfoCard",
                                label: "encryption",
                                widgetProps: {icon: "#ShieldLock", languageKeyCategory: "encryptionValues"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            dependent: "authType",
                            field: {
                                name: "authType",
                                widget: "#SmallInfoCard",
                                label: "authType",
                                widgetProps: {icon: "#Key", languageKeyCategory: "authTypeValues"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            dependent: "username",
                            field: {
                                name: "username",
                                widget: "#SmallInfoCard",
                                label: "username",
                                widgetProps: {icon: "#User"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            dependent: "hasPassword",
                            field: {
                                name: "hasPassword",
                                widget: "#SmallInfoCard",
                                label: "hasPassword",
                                widgetProps: {icon: "#Lock", valueType: "boolean"},
                            },
                        },
                    ],
                },
            ],
        },
        {
            render: "#SheetGroup",
            props: {title: "sender"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 2},
                    children: [
                        {
                            render: "#SmallInfoCard",
                            dependent: "fromEmail",
                            field: {
                                name: "fromEmail",
                                widget: "#SmallInfoCard",
                                label: "fromEmail",
                                widgetProps: {icon: "#Mail"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            dependent: "fromName",
                            field: {
                                name: "fromName",
                                widget: "#SmallInfoCard",
                                label: "fromName",
                                widgetProps: {icon: "#Id"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            dependent: "replyTo",
                            field: {
                                name: "replyTo",
                                widget: "#SmallInfoCard",
                                label: "replyTo",
                                widgetProps: {icon: "#MailForward"},
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
                            dependent: "lastTestStatus",
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
                            dependent: "lastTestedAt",
                            field: {
                                name: "lastTestedAt",
                                widget: "#SmallInfoCard",
                                label: "lastTestedAt",
                                widgetProps: {icon: "#Clock", format: "dateTime"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            dependent: "lastTestMessage",
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
    ],
};

const smtpFormFields: ViewConfig["nodes"] = [
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
                    name: "sequence",
                    widget: "#Input",
                    label: "form.sequenceLabel",
                    placeholder: "form.sequencePlaceholder",
                    required: true,
                    widgetProps: {type: "number", min: 0, step: 1},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "active",
                    widget: "#Switch",
                    label: "form.activeLabel",
                },
            },
            {
                render: "#Field",
                field: {
                    name: "host",
                    widget: "#Input",
                    label: "form.hostLabel",
                    placeholder: "form.hostPlaceholder",
                    required: true,
                },
            },
            {
                render: "#Field",
                field: {
                    name: "port",
                    widget: "#Input",
                    label: "form.portLabel",
                    placeholder: "form.portPlaceholder",
                    required: true,
                    widgetProps: {type: "number", min: 1, max: 65535, step: 1},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "encryption",
                    widget: "#SimpleSelect",
                    label: "form.encryptionLabel",
                    required: true,
                    widgetProps: {
                        options: [
                            {value: "none", label: "form.encryption.none"},
                            {value: "ssl", label: "form.encryption.ssl"},
                            {value: "starttls", label: "form.encryption.starttls"},
                        ],
                        className: "grow w-full",
                    },
                },
            },
            {
                render: "#Field",
                field: {
                    name: "authType",
                    widget: "#SimpleSelect",
                    label: "form.authTypeLabel",
                    required: true,
                    widgetProps: {
                        options: [
                            {value: "login", label: "form.authType.login"},
                            {value: "none", label: "form.authType.none"},
                        ],
                        className: "grow w-full",
                    },
                },
            },
            {
                render: "#FormWhenFieldValueIn",
                props: {watchField: "authType", whenValues: ["login"], clearFields: ["username", "password"]},
                children: [
                    {
                        render: "#Field",
                        field: {
                            name: "username",
                            widget: "#Input",
                            label: "form.usernameLabel",
                            placeholder: "form.usernamePlaceholder",
                        },
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "password",
                            widget: "#Input",
                            label: "form.passwordLabel",
                            placeholder: "form.passwordPlaceholder",
                            skipWriteAccessGate: true,
                            widgetProps: {type: "password", autoComplete: "new-password"},
                        },
                    },
                ],
            },
        ],
    },
    {
        render: "#FormGrid",
        props: {columns: 3},
        children: [
            {
                render: "#Field",
                field: {
                    name: "fromEmail",
                    widget: "#Input",
                    label: "form.fromEmailLabel",
                    placeholder: "form.fromEmailPlaceholder",
                    required: true,
                    widgetProps: {type: "email"},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "fromName",
                    widget: "#Input",
                    label: "form.fromNameLabel",
                    placeholder: "form.fromNamePlaceholder",
                },
            },
            {
                render: "#Field",
                field: {
                    name: "replyTo",
                    widget: "#Input",
                    label: "form.replyToLabel",
                    placeholder: "form.replyToPlaceholder",
                    widgetProps: {type: "email"},
                },
            },
        ],
    },
];

export const smtpServerCreateFormView: ViewConfig = {
    model: "smtpServers",
    viewType: "form",
    viewMode: "create",
    accessModel: "smtpServers",
    apiUrl: "/api/auxiliary/smtpServer",
    method: "PUT",
    nodes: smtpFormFields,
};

export const smtpServerEditFormView: ViewConfig = {
    model: "smtpServers",
    viewType: "form",
    viewMode: "edit",
    accessModel: "smtpServers",
    apiUrl: "/api/auxiliary/smtpServer",
    method: "PATCH",
    nodes: smtpFormFields,
};

export const smtpServerViews: ViewConfig[] = [smtpServerSheetView, smtpServerCreateFormView, smtpServerEditFormView];

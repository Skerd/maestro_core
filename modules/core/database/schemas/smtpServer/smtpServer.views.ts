import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {
    SMTP_EMAIL_MAX,
    SMTP_HOST_MAX,
    SMTP_NAME_MAX,
    SMTP_SHORT_TEXT_MAX,
} from "armonia/src/modules/core/api/auxiliary/private/smtpServer/smtpServer.schema-def";
import {lifecycleSheetGroup} from "../shared/lifecycleSheetGroup";

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
                            permissions: {read: "sequence"},
                            field: {
                                name: "sequence",
                                widget: "#DisplayCard",
                                label: "sequence",
                                widgetProps: {icon: "#ListOrdered", type: "number"},
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
            props: {title: "connection"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 3},
                    children: [
                        {
                            render: "#DisplayCard",
                            permissions: {read: "host"},
                            field: {
                                name: "host",
                                widget: "#DisplayCard",
                                label: "host",
                                widgetProps: {icon: "#Server"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "port"},
                            field: {
                                name: "port",
                                widget: "#DisplayCard",
                                label: "port",
                                widgetProps: {icon: "#Plug", type: "number"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "encryption"},
                            field: {
                                name: "encryption",
                                widget: "#DisplayCard",
                                label: "encryption",
                                widgetProps: {icon: "#ShieldLock", languageKeyCategory: "encryptionValues", type: "enum"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "authType"},
                            field: {
                                name: "authType",
                                widget: "#DisplayCard",
                                label: "authType",
                                widgetProps: {icon: "#Key", languageKeyCategory: "authTypeValues", type: "enum"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "username"},
                            field: {
                                name: "username",
                                widget: "#DisplayCard",
                                label: "username",
                                widgetProps: {icon: "#User"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            dependent: "hasPassword",
                            permissions: {read: "username"},
                            field: {
                                name: "hasPassword",
                                widget: "#DisplayCard",
                                label: "hasPassword",
                                widgetProps: {icon: "#Lock", type: "boolean"},
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
                    props: {columns: 3},
                    children: [
                        {
                            render: "#DisplayCard",
                            permissions: {read: "fromEmail"},
                            field: {
                                name: "fromEmail",
                                widget: "#DisplayCard",
                                label: "fromEmail",
                                widgetProps: {icon: "#Mail", type: "email"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "fromName"},
                            field: {
                                name: "fromName",
                                widget: "#DisplayCard",
                                label: "fromName",
                                widgetProps: {icon: "#Id"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "replyTo"},
                            field: {
                                name: "replyTo",
                                widget: "#DisplayCard",
                                label: "replyTo",
                                widgetProps: {icon: "#MailForward", type: "email"},
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

const smtpServerCreateFormNode: ViewConfig["nodes"] = [
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
                    widgetProps: {maxLength: SMTP_NAME_MAX},
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
                    widgetProps: {type: "number", min: 0, max: 10000, step: 1},
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
                    widgetProps: {maxLength: SMTP_HOST_MAX},
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
                            widgetProps: {maxLength: SMTP_SHORT_TEXT_MAX},
                        },
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "password",
                            widget: "#Input",
                            label: "form.passwordLabel",
                            placeholder: "form.passwordPlaceholder",
                            widgetProps: {
                                type: "password",
                                autoComplete: "new-password"
                            }
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
                    widgetProps: {type: "email", maxLength: SMTP_EMAIL_MAX},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "fromName",
                    widget: "#Input",
                    label: "form.fromNameLabel",
                    placeholder: "form.fromNamePlaceholder",
                    widgetProps: {maxLength: SMTP_SHORT_TEXT_MAX},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "replyTo",
                    widget: "#Input",
                    label: "form.replyToLabel",
                    placeholder: "form.replyToPlaceholder",
                    widgetProps: {type: "email", maxLength: SMTP_EMAIL_MAX},
                },
            },
        ],
    },
];

const smtpServerEditFormNode: ViewConfig["nodes"] = [
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
                    widgetProps: {maxLength: SMTP_NAME_MAX},
                },
                permissions: {read: "name", write: "name"},
            },
            {
                render: "#Field",
                field: {
                    name: "sequence",
                    widget: "#Input",
                    label: "form.sequenceLabel",
                    placeholder: "form.sequencePlaceholder",
                    required: true,
                    widgetProps: {type: "number", min: 0, max: 10000, step: 1},
                },
                permissions: {read: "sequence", write: "sequence"},
            },
            {
                render: "#Field",
                field: {
                    name: "host",
                    widget: "#Input",
                    label: "form.hostLabel",
                    placeholder: "form.hostPlaceholder",
                    required: true,
                    widgetProps: {maxLength: SMTP_HOST_MAX},
                },
                permissions: {read: "host", write: "host"},
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
                permissions: {read: "port", write: "port"},
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
                permissions: {read: "encryption", write: "encryption"},
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
                permissions: {read: "authType", write: "authType"},
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
                            widgetProps: {maxLength: SMTP_SHORT_TEXT_MAX},
                        },
                        permissions: {read: "username", write: "username"},
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
                        permissions: {write: "passwordEncrypted"},
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
                    widgetProps: {type: "email", maxLength: SMTP_EMAIL_MAX},
                },
                permissions: {read: "fromEmail", write: "fromEmail"},
            },
            {
                render: "#Field",
                field: {
                    name: "fromName",
                    widget: "#Input",
                    label: "form.fromNameLabel",
                    placeholder: "form.fromNamePlaceholder",
                    widgetProps: {maxLength: SMTP_SHORT_TEXT_MAX},
                },
                permissions: {read: "fromName", write: "fromName"},
            },
            {
                render: "#Field",
                field: {
                    name: "replyTo",
                    widget: "#Input",
                    label: "form.replyToLabel",
                    placeholder: "form.replyToPlaceholder",
                    widgetProps: {type: "email", maxLength: SMTP_EMAIL_MAX},
                },
                permissions: {read: "replyTo", write: "replyTo"},
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
    nodes: smtpServerCreateFormNode,
};

export const smtpServerEditFormView: ViewConfig = {
    model: "smtpServers",
    viewType: "form",
    viewMode: "edit",
    accessModel: "smtpServers",
    apiUrl: "/api/auxiliary/smtpServer",
    method: "PATCH",
    nodes: smtpServerEditFormNode,
};

export const smtpServerViews: ViewConfig[] = [smtpServerSheetView, smtpServerCreateFormView, smtpServerEditFormView];

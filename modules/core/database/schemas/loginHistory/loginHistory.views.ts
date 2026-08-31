import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";

export const loginHistorySheetView: ViewConfig = {
    model: "loginhistories",
    viewType: "sheet",
    accessModel: "loginHistories",
    apiUrl: "/api/user/loginHistory",
    header: {
        titleField: "ip",
        subtitleKey: "loginHistory",
        showCloseButton: true,
    },
    nodes: [
        {
            render: "#SheetGroup",
            props: {title: "loginDetails"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 2},
                    children: [
                        {
                            render: "#DisplayCard",
                            permissions: {read: "user"},
                            field: {
                                name: "user",
                                widget: "#DisplayCard",
                                label: "user",
                                widgetProps: {
                                    icon: "#User",
                                    parent: "user",
                                    valuePath: ["name", "surname"],
                                    joinSeparator: " ",
                                },
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "time"},
                            field: {
                                name: "time",
                                widget: "#DisplayCard",
                                label: "time",
                                widgetProps: {
                                    icon: "#Clock",
                                },
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "status"},
                            field: {
                                name: "status",
                                widget: "#DisplayCard",
                                label: "status",
                                widgetProps: {
                                    languageKeyCategory: "statusValues",
                                    type: "enum",
                                },
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "mfa"},
                            field: {
                                name: "mfa",
                                widget: "#DisplayCard",
                                label: "mfa",
                                widgetProps: {type: "boolean"},
                            },
                        },
                    ],
                },
            ],
        },
        {
            render: "#SheetGroup",
            props: {title: "clientInfo"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 2},
                    children: [
                        {
                            render: "#DisplayCard",
                            permissions: {read: "device"},
                            field: {name: "device", widget: "#DisplayCard", label: "device"},
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "os"},
                            field: {name: "os", widget: "#DisplayCard", label: "os"},
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "browser"},
                            field: {name: "browser", widget: "#DisplayCard", label: "browser"},
                        },
                    ],
                },
                {
                    render: "#SheetGrid",
                    props: {columns: 1},
                    children: [
                        {
                            render: "#DisplayCard",
                            permissions: {read: "userAgent"},
                            field: {
                                name: "userAgent",
                                widget: "#DisplayCard",
                                label: "userAgent",
                                widgetProps: {type: "longText"},
                            },
                        },
                    ],
                },
            ],
        },
    ],
};

export const loginHistoryViews: ViewConfig[] = [loginHistorySheetView];

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
                            render: "#SmallInfoCard",
                            dependent: "user",
                            permissions: {read: "user"},
                            field: {
                                name: "user",
                                widget: "#SmallInfoCard",
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
                            render: "#SmallInfoCard",
                            permissions: {read: "time"},
                            field: {
                                name: "time",
                                widget: "#SmallInfoCard",
                                label: "time",
                                widgetProps: {
                                    icon: "#Clock",
                                },
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            permissions: {read: "status"},
                            field: {
                                name: "status",
                                widget: "#SmallInfoCard",
                                label: "status",
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            permissions: {read: "mfa"},
                            field: {
                                name: "mfa",
                                widget: "#SmallInfoCard",
                                label: "mfa",
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
                            render: "#SmallInfoCard",
                            permissions: {read: "device"},
                            field: {name: "device", widget: "#SmallInfoCard", label: "device"},
                        },
                        {
                            render: "#SmallInfoCard",
                            permissions: {read: "os"},
                            field: {name: "os", widget: "#SmallInfoCard", label: "os"},
                        },
                        {
                            render: "#SmallInfoCard",
                            permissions: {read: "browser"},
                            field: {name: "browser", widget: "#SmallInfoCard", label: "browser"},
                        },
                        {
                            render: "#SmallInfoCard",
                            permissions: {read: "userAgent"},
                            field: {name: "userAgent", widget: "#SmallInfoCard", label: "userAgent"},
                        },
                    ],
                },
            ],
        },
    ],
};

export const loginHistoryViews: ViewConfig[] = [loginHistorySheetView];

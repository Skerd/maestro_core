import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";

export const userSessionSheetView: ViewConfig = {
    model: "usersessions",
    viewType: "sheet",
    accessModel: "userSessions",
    apiUrl: "/api/user/userSession",
    header: {
        titleField: "sessionId",
        subtitleKey: "userSession",
        showCloseButton: true,
    },
    nodes: [
        {
            render: "#SheetGroup",
            props: {title: "sessionDetails"},
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
                            permissions: {read: "deviceId"},
                            field: {name: "deviceId", widget: "#DisplayCard", label: "deviceId"},
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "isActive"},
                            field: {name: "isActive", widget: "#DisplayCard", label: "isActive"},
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "lastActiveAt"},
                            field: {name: "lastActiveAt", widget: "#DisplayCard", label: "lastActiveAt"},
                        },
                    ],
                },
            ],
        },
        {
            render: "#SheetGroup",
            props: {title: "networkInfo"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 1},
                    children: [
                        {
                            render: "#DisplayCard",
                            permissions: {read: "ipAddress"},
                            field: {name: "ipAddress", widget: "#DisplayCard", label: "ipAddress"},
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "userAgent"},
                            field: {name: "userAgent", widget: "#DisplayCard", label: "userAgent"},
                        },
                    ],
                },
            ],
        },
    ],
};

export const userSessionViews: ViewConfig[] = [userSessionSheetView];

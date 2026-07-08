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
                            permissions: {read: "deviceId"},
                            field: {name: "deviceId", widget: "#SmallInfoCard", label: "deviceId"},
                        },
                        {
                            render: "#SmallInfoCard",
                            permissions: {read: "isActive"},
                            field: {name: "isActive", widget: "#SmallInfoCard", label: "isActive"},
                        },
                        {
                            render: "#SmallInfoCard",
                            permissions: {read: "lastActiveAt"},
                            field: {name: "lastActiveAt", widget: "#SmallInfoCard", label: "lastActiveAt"},
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
                            render: "#SmallInfoCard",
                            permissions: {read: "ipAddress"},
                            field: {name: "ipAddress", widget: "#SmallInfoCard", label: "ipAddress"},
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

export const userSessionViews: ViewConfig[] = [userSessionSheetView];

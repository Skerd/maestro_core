import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {lifecycleSheetGroup} from "../shared/lifecycleSheetGroup";

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
                    props: {columns: 3},
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
                                widgetProps: {icon: "#Clock", type: "dateTime"},
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
                                    icon: "#CircleDot",
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
                                widgetProps: {icon: "#ShieldLock", type: "boolean"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            dependent: "reason",
                            permissions: {read: "reason"},
                            field: {
                                name: "reason",
                                widget: "#DisplayCard",
                                label: "reason",
                                widgetProps: {icon: "#IconAlignLeft"},
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
                    props: {columns: 3},
                    children: [
                        {
                            render: "#DisplayCard",
                            permissions: {read: "device"},
                            field: {
                                name: "device",
                                widget: "#DisplayCard",
                                label: "device",
                                widgetProps: {icon: "#Devices"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "os"},
                            field: {
                                name: "os",
                                widget: "#DisplayCard",
                                label: "os",
                                widgetProps: {icon: "#DeviceDesktop"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "browser"},
                            field: {
                                name: "browser",
                                widget: "#DisplayCard",
                                label: "browser",
                                widgetProps: {icon: "#World"},
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
                            permissions: {read: "userAgent"},
                            field: {
                                name: "userAgent",
                                widget: "#DisplayCard",
                                label: "userAgent",
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
                            permissions: {read: "ip"},
                            field: {
                                name: "ip",
                                widget: "#DisplayCard",
                                label: "ip",
                                widgetProps: {icon: "#Globe"},
                            },
                        },
                    ],
                },
            ],
        },
        {
            render: "#SheetGroup",
            props: {
                title: "geolocation",
                defaultOpen: true,
            },
            permissions: {readAny: ["geolocation"]},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 3},
                    children: [
                        {
                            render: "#DisplayCard",
                            permissions: {read: "geolocation"},
                            field: {
                                name: "geolocation.ip",
                                widget: "#DisplayCard",
                                label: "geoIp",
                                widgetProps: {icon: "#Globe"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "geolocation"},
                            field: {
                                name: "geolocation.hostname",
                                widget: "#DisplayCard",
                                label: "geoHostname",
                                widgetProps: {icon: "#Server"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "geolocation"},
                            field: {
                                name: "geolocation.city",
                                widget: "#DisplayCard",
                                label: "geoCity",
                                widgetProps: {icon: "#MapPin"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "geolocation"},
                            field: {
                                name: "geolocation.region",
                                widget: "#DisplayCard",
                                label: "geoRegion",
                                widgetProps: {icon: "#MapPin"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "geolocation"},
                            field: {
                                name: "geolocation.country",
                                widget: "#DisplayCard",
                                label: "geoCountry",
                                widgetProps: {icon: "#Flag"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "geolocation"},
                            field: {
                                name: "geolocation.loc",
                                widget: "#DisplayCard",
                                label: "geoLoc",
                                widgetProps: {icon: "#MapPin"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "geolocation"},
                            field: {
                                name: "geolocation.org",
                                widget: "#DisplayCard",
                                label: "geoOrg",
                                widgetProps: {icon: "#Building"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "geolocation"},
                            field: {
                                name: "geolocation.postal",
                                widget: "#DisplayCard",
                                label: "geoPostal",
                                widgetProps: {icon: "#Mail"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "geolocation"},
                            field: {
                                name: "geolocation.timezone",
                                widget: "#DisplayCard",
                                label: "geoTimezone",
                                widgetProps: {icon: "#Clock"},
                            },
                        },
                    ],
                },
            ],
        },
        lifecycleSheetGroup,
    ],
};

export const loginHistoryViews: ViewConfig[] = [loginHistorySheetView];

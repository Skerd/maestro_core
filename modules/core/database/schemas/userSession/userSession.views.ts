import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {lifecycleSheetGroup} from "../shared/lifecycleSheetGroup";

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
                            permissions: {read: "sessionId"},
                            field: {
                                name: "sessionId",
                                widget: "#DisplayCard",
                                label: "sessionId",
                                widgetProps: {icon: "#Tag"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "deviceId"},
                            field: {
                                name: "deviceId",
                                widget: "#DisplayCard",
                                label: "deviceId",
                                widgetProps: {icon: "#Devices"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "isActive"},
                            field: {
                                name: "isActive",
                                widget: "#DisplayCard",
                                label: "isActive",
                                widgetProps: {icon: "#Power", type: "boolean"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "lastActiveAt"},
                            field: {
                                name: "lastActiveAt",
                                widget: "#DisplayCard",
                                label: "lastActiveAt",
                                widgetProps: {icon: "#History", type: "dateTime"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "expiresAt"},
                            field: {
                                name: "expiresAt",
                                widget: "#DisplayCard",
                                label: "expiresAt",
                                widgetProps: {icon: "#CalendarClock", type: "dateTime"},
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
                            permissions: {read: "ipAddress"},
                            field: {
                                name: "ipAddress",
                                widget: "#DisplayCard",
                                label: "ipAddress",
                                widgetProps: {icon: "#Globe"},
                            },
                        },
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
            render: "#ReferencesViewModeScope",
            props: {
                storageKey: "userSession.sheet.geolocation.listDisplay",
                defaultMode: "cards",
            },
            children: [
                {
                    render: "#SheetGroup",
                    props: {
                        title: "geolocation",
                        titleActions: "#ReferencesViewModeToggle",
                        defaultOpen: true,
                    },
                    permissions: {readAny: ["geolocation"]},
                    children: [
                        {
                            render: "div",
                            props: {className: "rounded-lg bg-muted/30 border border-border/50 max-w-full"},
                            children: [
                                {
                                    render: "#SheetEmbeddedItemsList",
                                    permissions: {read: "geolocation"},
                                    field: {name: "geolocation", widget: "#SheetEmbeddedItemsList", widgetProps: {pageSize: 10, cardColumns: 4, sortField: "time", compactSummaryFields: ["city", "country", "time"], fields: [{name: "ip", type: "text", icon: "#Globe", labelKey: "geoIp"}, {name: "hostname", type: "text", icon: "#Server", labelKey: "geoHostname"}, {name: "city", type: "text", icon: "#MapPin", labelKey: "geoCity"}, {name: "region", type: "text", icon: "#MapPin", labelKey: "geoRegion"}, {name: "country", type: "text", icon: "#Flag", labelKey: "geoCountry", flagFromValue: true}, {name: "loc", type: "text", icon: "#MapPin", labelKey: "geoLoc"}, {name: "org", type: "text", icon: "#Building", labelKey: "geoOrg"}, {name: "postal", type: "text", icon: "#Mail", labelKey: "geoPostal"}, {name: "timezone", type: "text", icon: "#Clock", labelKey: "geoTimezone"}, {name: "time", type: "text", format: "dateTime", icon: "#History", labelKey: "geoTime"}]}},
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        lifecycleSheetGroup,
    ],
};

export const userSessionViews: ViewConfig[] = [userSessionSheetView];

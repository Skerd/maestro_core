import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {
    CRON_JOB_CRON_EXPRESSION_MAX,
    CRON_JOB_DESCRIPTION_MAX,
    CRON_JOB_MAX_RETRIES_MAX,
    CRON_JOB_NAME_MAX,
    CRON_JOB_PRIORITY_MAX,
    CRON_JOB_RETRY_DELAY_SECONDS_MAX,
    CRON_JOB_TIMEOUT_SECONDS_MAX,
    CRON_JOB_TIMEOUT_SECONDS_MIN,
} from "armonia/src/modules/core/api/auxiliary/private/cronJob/cronJob.schema-def";
import {lifecycleSheetGroup} from "@coreModule/database/schemas/shared/lifecycleSheetGroup";

export const cronJobSheetView: ViewConfig = {
    model: "cronjobs",
    viewType: "sheet",
    accessModel: "cronjobs",
    apiUrl: "/api/auxiliary/cron-jobs",
    header: {
        titleField: "name",
        subtitleKey: "code",
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
                            permissions: {read: "handler"},
                            field: {
                                name: "handler",
                                widget: "#DisplayCard",
                                label: "handler",
                                widgetProps: {icon: "#Code"},
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
                        {
                            render: "#DisplayCard",
                            permissions: {read: "pausedAt"},
                            field: {
                                name: "pausedAt",
                                widget: "#DisplayCard",
                                label: "pausedAt",
                                widgetProps: {icon: "#PlayerPause", type: "dateTime"},
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
                            permissions: {read: "description"},
                            dependent: "description",
                            field: {
                                name: "description",
                                widget: "#DisplayCard",
                                label: "description",
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
            props: {title: "schedule"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 3},
                    children: [
                        {
                            render: "#DisplayCard",
                            permissions: {read: "cronExpression"},
                            field: {
                                name: "cronExpression",
                                widget: "#DisplayCard",
                                label: "cronExpression",
                                widgetProps: {icon: "#Clock"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "nextRunAt"},
                            field: {
                                name: "nextRunAt",
                                widget: "#DisplayCard",
                                label: "nextRunAt",
                                widgetProps: {icon: "#CalendarClock", type: "dateTime"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "lastRunAt"},
                            field: {
                                name: "lastRunAt",
                                widget: "#DisplayCard",
                                label: "lastRunAt",
                                widgetProps: {icon: "#History", type: "dateTime"},
                            },
                        },
                    ],
                },
            ],
        },
        {
            render: "#SheetGroup",
            props: {title: "execution"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 3},
                    children: [
                        {
                            render: "#DisplayCard",
                            permissions: {read: "priority"},
                            field: {
                                name: "priority",
                                widget: "#DisplayCard",
                                label: "priority",
                                widgetProps: {icon: "#ListOrdered", type: "number"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "maxRetries"},
                            field: {
                                name: "maxRetries",
                                widget: "#DisplayCard",
                                label: "maxRetries",
                                widgetProps: {icon: "#Repeat", type: "number"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "retryDelaySeconds"},
                            field: {
                                name: "retryDelaySeconds",
                                widget: "#DisplayCard",
                                label: "retryDelaySeconds",
                                widgetProps: {icon: "#Hourglass", type: "number"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "timeoutSeconds"},
                            field: {
                                name: "timeoutSeconds",
                                widget: "#DisplayCard",
                                label: "timeoutSeconds",
                                widgetProps: {icon: "#Timer", type: "number"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "missedRunPolicy"},
                            field: {
                                name: "missedRunPolicy",
                                widget: "#DisplayCard",
                                label: "missedRunPolicy",
                                widgetProps: {
                                    icon: "#Layers",
                                    type: "enum",
                                    languageKeyCategory: "missedRunPolicyValues",
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

const cronJobEditFormFields: ViewConfig["nodes"] = [
    {
        render: "#FormGrid",
        props: {columns: 2},
        children: [
            {
                render: "#Field",
                field: {
                    name: "name",
                    widget: "#Input",
                    label: "form.nameLabel",
                    required: true,
                    widgetProps: {maxLength: CRON_JOB_NAME_MAX},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "cronExpression",
                    widget: "#Input",
                    label: "form.cronExpressionLabel",
                    placeholder: "form.cronExpressionPlaceholder",
                    required: true,
                    widgetProps: {maxLength: CRON_JOB_CRON_EXPRESSION_MAX},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "priority",
                    widget: "#Input",
                    label: "form.priorityLabel",
                    required: true,
                    widgetProps: {type: "number", min: 0, max: CRON_JOB_PRIORITY_MAX, step: 1},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "maxRetries",
                    widget: "#Input",
                    label: "form.maxRetriesLabel",
                    required: true,
                    widgetProps: {type: "number", min: 0, max: CRON_JOB_MAX_RETRIES_MAX, step: 1},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "retryDelaySeconds",
                    widget: "#Input",
                    label: "form.retryDelaySecondsLabel",
                    required: true,
                    widgetProps: {type: "number", min: 0, max: CRON_JOB_RETRY_DELAY_SECONDS_MAX, step: 1},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "timeoutSeconds",
                    widget: "#Input",
                    label: "form.timeoutSecondsLabel",
                    widgetProps: {
                        type: "number",
                        min: CRON_JOB_TIMEOUT_SECONDS_MIN,
                        max: CRON_JOB_TIMEOUT_SECONDS_MAX,
                        step: 1,
                    },
                },
            },
            {
                render: "#Field",
                field: {
                    name: "missedRunPolicy",
                    widget: "#SimpleSelect",
                    label: "form.missedRunPolicyLabel",
                    required: true,
                    widgetProps: {
                        options: [
                            {value: "skip", label: "form.missedRunPolicy.skip"},
                            {value: "run_once", label: "form.missedRunPolicy.run_once"},
                            {value: "catch_up", label: "form.missedRunPolicy.catch_up"},
                        ],
                        className: "grow w-full",
                    },
                },
            },
        ],
    },
    {
        render: "#FormGrid",
        props: {columns: 1},
        children: [
            {
                render: "#Field",
                field: {
                    name: "description",
                    widget: "#Textarea",
                    label: "form.descriptionLabel",
                    placeholder: "form.descriptionPlaceholder",
                    widgetProps: {
                        className: "resize-none max-h-[250px] overflow-y-auto",
                        maxLength: CRON_JOB_DESCRIPTION_MAX,
                    },
                },
            },
        ],
    },
];

export const cronJobEditFormView: ViewConfig = {
    model: "cronjobs",
    viewType: "form",
    viewMode: "edit",
    accessModel: "cronjobs",
    apiUrl: "/api/auxiliary/cron-jobs",
    method: "PATCH",
    nodes: cronJobEditFormFields,
};

export const cronJobViews = [cronJobSheetView, cronJobEditFormView];

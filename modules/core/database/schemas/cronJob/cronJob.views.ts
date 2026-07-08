import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";

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
                    props: {columns: 2},
                    children: [
                        {render: "#SmallInfoCard", dependent: "handler", field: {name: "handler", widget: "#SmallInfoCard", label: "handler"}},
                        {
                            render: "#SmallInfoCard",
                            dependent: "type",
                            field: {
                                name: "type",
                                widget: "#SmallInfoCard",
                                label: "type",
                                widgetProps: {languageKeyCategory: "typeValues"},
                            },
                        },
                        {
                            render: "#SmallInfoCard",
                            dependent: "active",
                            field: {
                                name: "active",
                                widget: "#SmallInfoCard",
                                label: "active",
                                widgetProps: {valueType: "boolean"},
                            },
                        },
                        {render: "#SmallInfoCard", dependent: "nextRunAt", field: {name: "nextRunAt", widget: "#SmallInfoCard", label: "nextRunAt"}},
                        {render: "#SmallInfoCard", dependent: "lastRunAt", field: {name: "lastRunAt", widget: "#SmallInfoCard", label: "lastRunAt"}},
                    ],
                },
            ],
        },
    ],
};

const cronJobFormFields: ViewConfig["nodes"] = [
    {
        render: "#FormGrid",
        props: {columns: 2},
        children: [
            {render: "#Field", field: {name: "code", widget: "#Input", label: "form.codeLabel", required: true}},
            {render: "#Field", field: {name: "name", widget: "#Input", label: "form.nameLabel", required: true}},
            {render: "#Field", field: {name: "handler", widget: "#Input", label: "form.handlerLabel", required: true}},
            {
                render: "#Field",
                field: {
                    name: "type",
                    widget: "#SimpleSelect",
                    label: "form.typeLabel",
                    required: true,
                    widgetProps: {
                        options: [
                            {value: "interval", label: "form.type.interval"},
                            {value: "cron", label: "form.type.cron"},
                            {value: "once", label: "form.type.once"},
                            {value: "queue", label: "form.type.queue"},
                        ],
                        className: "grow w-full",
                    },
                },
            },
            {
                render: "#FormWhenFieldValueIn",
                props: {watchField: "type", whenValues: ["cron"], clearFields: ["cronExpression"]},
                children: [
                    {
                        render: "#Field",
                        field: {
                            name: "cronExpression",
                            widget: "#Input",
                            label: "form.cronExpressionLabel",
                            placeholder: "form.cronExpressionPlaceholder",
                            required: true,
                        },
                    },
                ],
            },
            {
                render: "#FormWhenFieldValueIn",
                props: {watchField: "type", whenValues: ["interval"], clearFields: ["interval"]},
                children: [
                    {
                        render: "#FormGrid",
                        props: {columns: 2},
                        children: [
                            {
                                render: "#Field",
                                field: {
                                    name: "interval.value",
                                    widget: "#Input",
                                    label: "form.intervalValueLabel",
                                    placeholder: "form.intervalValuePlaceholder",
                                    required: true,
                                    widgetProps: {type: "number", min: 1, step: 1},
                                },
                            },
                            {
                                render: "#Field",
                                field: {
                                    name: "interval.unit",
                                    widget: "#SimpleSelect",
                                    label: "form.intervalUnitLabel",
                                    required: true,
                                    widgetProps: {
                                        options: [
                                            {value: "seconds", label: "form.intervalUnit.seconds"},
                                            {value: "minutes", label: "form.intervalUnit.minutes"},
                                            {value: "hours", label: "form.intervalUnit.hours"},
                                            {value: "days", label: "form.intervalUnit.days"},
                                        ],
                                        className: "grow w-full",
                                    },
                                },
                            },
                        ],
                    },
                ],
            },
            {
                render: "#Field",
                field: {
                    name: "scope",
                    widget: "#SimpleSelect",
                    label: "form.scopeLabel",
                    required: true,
                    widgetProps: {
                        options: [
                            {value: "global", label: "form.scope.global"},
                            {value: "company", label: "form.scope.company"},
                        ],
                        className: "grow w-full",
                    },
                },
            },
            {
                render: "#FormWhenFieldValueIn",
                props: {watchField: "scope", whenValues: ["company"], clearFields: ["company"]},
                children: [
                    {
                        render: "#Field",
                        field: {
                            name: "company",
                            widget: "#Select",
                            label: "form.companyLabel",
                            placeholder: "form.companyPlaceholder",
                            required: true,
                        },
                    },
                ],
            },
            {render: "#Field", field: {name: "active", widget: "#Switch", label: "form.activeLabel"}},
            {render: "#Field", field: {name: "priority", widget: "#Input", label: "form.priorityLabel", widgetProps: {type: "number"}}},
            {render: "#Field", field: {name: "maxRetries", widget: "#Input", label: "form.maxRetriesLabel", widgetProps: {type: "number"}}},
            {render: "#Field", field: {name: "description", widget: "#Textarea", label: "form.descriptionLabel"}},
        ],
    },
];

export const cronJobCreateFormView: ViewConfig = {
    model: "cronjobs",
    viewType: "form",
    viewMode: "create",
    accessModel: "cronjobs",
    apiUrl: "/api/auxiliary/cron-jobs",
    method: "PUT",
    nodes: cronJobFormFields,
};

export const cronJobEditFormView: ViewConfig = {
    model: "cronjobs",
    viewType: "form",
    viewMode: "edit",
    accessModel: "cronjobs",
    apiUrl: "/api/auxiliary/cron-jobs",
    method: "PATCH",
    nodes: cronJobFormFields,
};

export const cronJobViews = [cronJobSheetView, cronJobCreateFormView, cronJobEditFormView];

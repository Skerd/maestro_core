import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {
    BLOG_CATEGORY_DESCRIPTION_MAX,
    BLOG_CATEGORY_NAME_MAX,
    BLOG_CATEGORY_SLUG_MAX,
} from "armonia/src/modules/core/api/auxiliary/private/blogCategory/blogCategory.schema-def";
import {lifecycleSheetGroup} from "../shared/lifecycleSheetGroup";

export const blogCategorySheetView: ViewConfig = {
    model: "blogCategories",
    viewType: "sheet",
    accessModel: "blogCategories",
    apiUrl: "/api/auxiliary/blogCategory",
    header: {
        titleField: "name",
        subtitleKey: "blogCategory",
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
                            permissions: {read: "slug"},
                            field: {
                                name: "slug",
                                widget: "#DisplayCard",
                                label: "slug",
                                widgetProps: {icon: "#Hash"},
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
        lifecycleSheetGroup,
    ],
};

const blogCategoryCreateFormNodes: ViewConfig["nodes"] = [
    {
        render: "#FormGrid",
        props: {columns: 1},
        children: [
            {
                render: "#Field",
                field: {
                    name: "name",
                    widget: "#Input",
                    label: "form.nameLabel",
                    placeholder: "form.namePlaceholder",
                    required: true,
                    widgetProps: {maxLength: BLOG_CATEGORY_NAME_MAX},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "slug",
                    widget: "#Input",
                    label: "form.slugLabel",
                    placeholder: "form.slugPlaceholder",
                    required: true,
                    widgetProps: {maxLength: BLOG_CATEGORY_SLUG_MAX},
                },
            },
            {
                render: "#Field",
                field: {
                    name: "description",
                    widget: "#Textarea",
                    label: "form.descriptionLabel",
                    placeholder: "form.descriptionPlaceholder",
                    widgetProps: {
                        className: "field-sizing-fixed min-h-[120px] resize-none max-h-[250px] overflow-y-auto",
                        style: {maxHeight: 250},
                        maxLength: BLOG_CATEGORY_DESCRIPTION_MAX,
                    },
                },
            },
        ],
    },
];

const blogCategoryEditFormNodes: ViewConfig["nodes"] = [
    {
        render: "#FormGrid",
        props: {columns: 1},
        permissions: {writeAny: ["name", "slug", "description"]},
        children: [
            {
                render: "#Field",
                field: {
                    name: "name",
                    widget: "#Input",
                    label: "form.nameLabel",
                    placeholder: "form.namePlaceholder",
                    required: true,
                    widgetProps: {maxLength: BLOG_CATEGORY_NAME_MAX},
                },
                permissions: {read: "name", write: "name"},
            },
            {
                render: "#Field",
                field: {
                    name: "slug",
                    widget: "#Input",
                    label: "form.slugLabel",
                    placeholder: "form.slugPlaceholder",
                    required: true,
                    widgetProps: {maxLength: BLOG_CATEGORY_SLUG_MAX},
                },
                permissions: {read: "slug", write: "slug"},
            },
            {
                render: "#Field",
                field: {
                    name: "description",
                    widget: "#Textarea",
                    label: "form.descriptionLabel",
                    placeholder: "form.descriptionPlaceholder",
                    widgetProps: {
                        className: "field-sizing-fixed min-h-[120px] resize-none max-h-[250px] overflow-y-auto",
                        style: {maxHeight: 250},
                        maxLength: BLOG_CATEGORY_DESCRIPTION_MAX,
                    },
                },
                permissions: {read: "description", write: "description"},
            },
        ],
    },
];

export const blogCategoryCreateFormView: ViewConfig = {
    model: "blogCategories",
    viewType: "form",
    viewMode: "create",
    accessModel: "blogCategories",
    apiUrl: "/api/auxiliary/blogCategory",
    method: "PUT",
    nodes: blogCategoryCreateFormNodes,
};

export const blogCategoryEditFormView: ViewConfig = {
    model: "blogCategories",
    viewType: "form",
    viewMode: "edit",
    accessModel: "blogCategories",
    apiUrl: "/api/auxiliary/blogCategory",
    method: "PATCH",
    nodes: blogCategoryEditFormNodes,
};

export const blogCategoryViews: ViewConfig[] = [
    blogCategorySheetView,
    blogCategoryCreateFormView,
    blogCategoryEditFormView,
];

import type {ViewConfig} from "armonia/src/modules/core/api/auxiliary/private/viewConfig";
import {
    BLOG_CONTENT_MAX,
    BLOG_POST_EXCERPT_MAX,
    BLOG_POST_SLUG_MAX,
    BLOG_POST_TITLE_MAX,
} from "armonia/src/modules/core/api/auxiliary/private/blogPost/blogPost.schema-def";
import {lifecycleSheetGroup} from "../shared/lifecycleSheetGroup";

export const blogPostSheetView: ViewConfig = {
    model: "blogPosts",
    viewType: "sheet",
    accessModel: "blogPosts",
    apiUrl: "/api/auxiliary/blogPost",
    header: {
        titleField: "title",
        subtitleKey: "blogPost",
        showCloseButton: true,
    },
    nodes: [
        {
            render: "#SheetGroup",
            permissions: {
                readAny: [
                    "category",
                    "publishedAt",
                    "published",
                    "slug",
                    "title",
                    "excerpt",
                    "content",
                ],
            },
            props: {title: "overview"},
            children: [
                {
                    render: "#SheetGrid",
                    props: {columns: 3},
                    children: [
                        {
                            render: "#DisplayCard",
                            permissions: {read: "category"},
                            field: {
                                name: "category.name",
                                widget: "#DisplayCard",
                                label: "category",
                                widgetProps: {icon: "#Tag"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "published"},
                            field: {
                                name: "published",
                                widget: "#DisplayCard",
                                label: "published",
                                widgetProps: {icon: "#IconLabel", format: "boolean", type: "boolean"},
                            },
                        },
                        {
                            render: "#DisplayCard",
                            permissions: {read: "publishedAt"},
                            field: {
                                name: "publishedAt",
                                widget: "#DisplayCard",
                                label: "publishedAt",
                                widgetProps: {icon: "#Calendar", format: "date", type: "date"},
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
                            permissions: {read: "title"},
                            field: {
                                name: "title",
                                widget: "#DisplayCard",
                                label: "title",
                                widgetProps: {icon: "#IconLabel"},
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
                            permissions: {read: "excerpt"},
                            field: {
                                name: "excerpt",
                                widget: "#DisplayCard",
                                label: "excerpt",
                                widgetProps: {
                                    icon: "#IconAlignLeft",
                                    expandable: true,
                                    maxLength: 250,
                                },
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
                            permissions: {read: "content"},
                            field: {
                                name: "content",
                                widget: "#DisplayCard",
                                label: "content",
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
            permissions: {readAny: ["mainImage", "imageGallery"]},
            props: {title: "gallery"},
            children: [
                {
                    render: "div",
                    props: {className: "max-w-full"},
                    children: [
                        {
                            render: "#GalleryCarousel",
                            field: {
                                name: "mainImage",
                                widget: "#GalleryCarousel",
                                widgetProps: {
                                    imageGalleryField: "imageGallery",
                                    showThumbnails: false,
                                    allowFullScreen: false,
                                    coverAfterFirst: false,
                                    showPreviews: true,
                                    previewLocation: "right",
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

const blogPostCreateFormNodes: ViewConfig["nodes"] = [
    {
        render: "#TitleWithCollapse",
        props: {title: "generalInfo"},
        children: [
                {
                    render: "#FormGrid",
                    props: {columns: 2},
                    children: [
                        {
                            render: "#Field",
                            field: {
                                name: "category",
                                widget: "#ApiSelect",
                                label: "form.categoryLabel",
                                placeholder: "form.categoryPlaceholder",
                                required: true,
                                widgetProps: {
                                    apiUrl: "/api/auxiliary/blogCategory/select",
                                    method: "POST",
                                    pageSize: 50,
                                },
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
                                widgetProps: {maxLength: BLOG_POST_SLUG_MAX},
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
                            name: "title",
                            widget: "#Input",
                            label: "form.titleLabel",
                            placeholder: "form.titlePlaceholder",
                            required: true,
                            widgetProps: {maxLength: BLOG_POST_TITLE_MAX},
                        },
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "excerpt",
                            widget: "#Textarea",
                            label: "form.excerptLabel",
                            placeholder: "form.excerptPlaceholder",
                            widgetProps: {
                                className: "field-sizing-fixed resize-none max-h-[250px] overflow-y-auto",
                                style: {maxHeight: 250},
                                maxLength: BLOG_POST_EXCERPT_MAX,
                            },
                        },
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "content",
                            widget: "#Textarea",
                            label: "form.contentLabel",
                            placeholder: "form.contentPlaceholder",
                            required: true,
                            widgetProps: {
                                className: "field-sizing-fixed min-h-[120px] resize-none max-h-[250px] overflow-y-auto",
                                style: {maxHeight: 250},
                                maxLength: BLOG_CONTENT_MAX,
                            },
                        },
                    },
                ],
            },
        ],
    },
    {
        render: "#TitleWithCollapse",
        props: {title: "form.mainImageLabel"},
        children: [
            {
                render: "#Field",
                field: {
                    name: "mainImage",
                    widget: "#MediaField",
                    label: "form.mainImageLabel",
                    widgetProps: {mediaType: "image", mode: "single"},
                },
            },
        ],
    },
    {
        render: "#TitleWithCollapse",
        props: {title: "form.imageGalleryLabel"},
        children: [
            {
                render: "#Field",
                field: {
                    name: "imageGallery",
                    widget: "#MediaField",
                    label: "form.imageGalleryLabel",
                    widgetProps: {mediaType: "image", mode: "multiple", maxCount: 20},
                },
            },
        ],
    },
];

const blogPostEditFormNodes: ViewConfig["nodes"] = [
    {
        render: "#TitleWithCollapse",
        props: {title: "generalInfo"},
        permissions: {
            readAny: ["category", "slug", "title", "excerpt", "content"],
            writeAny: ["category", "slug", "title", "excerpt", "content"],
        },
        children: [
            {
                render: "#FormGrid",
                props: {columns: 2},
                children: [
                    {
                        render: "#Field",
                        field: {
                            name: "category",
                            widget: "#ApiSelect",
                            label: "form.categoryLabel",
                            placeholder: "form.categoryPlaceholder",
                            required: true,
                            widgetProps: {
                                apiUrl: "/api/auxiliary/blogCategory/select",
                                method: "POST",
                                pageSize: 50,
                            },
                        },
                        permissions: {read: "category", write: "category"},
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "slug",
                            widget: "#Input",
                            label: "form.slugLabel",
                            placeholder: "form.slugPlaceholder",
                            required: true,
                            widgetProps: {maxLength: BLOG_POST_SLUG_MAX},
                        },
                        permissions: {read: "slug", write: "slug"},
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
                            name: "title",
                            widget: "#Input",
                            label: "form.titleLabel",
                            placeholder: "form.titlePlaceholder",
                            required: true,
                            widgetProps: {maxLength: BLOG_POST_TITLE_MAX},
                        },
                        permissions: {read: "title", write: "title"},
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "excerpt",
                            widget: "#Textarea",
                            label: "form.excerptLabel",
                            placeholder: "form.excerptPlaceholder",
                            widgetProps: {
                                className: "field-sizing-fixed resize-none max-h-[250px] overflow-y-auto",
                                style: {maxHeight: 250},
                                maxLength: BLOG_POST_EXCERPT_MAX,
                            },
                        },
                        permissions: {read: "excerpt", write: "excerpt"},
                    },
                    {
                        render: "#Field",
                        field: {
                            name: "content",
                            widget: "#Textarea",
                            label: "form.contentLabel",
                            placeholder: "form.contentPlaceholder",
                            required: true,
                            widgetProps: {
                                className: "field-sizing-fixed min-h-[120px] resize-none max-h-[250px] overflow-y-auto",
                                style: {maxHeight: 250},
                                maxLength: BLOG_CONTENT_MAX,
                            },
                        },
                        permissions: {read: "content", write: "content"},
                    },
                ],
            },
        ],
    },
    {
        render: "#TitleWithCollapse",
        props: {title: "form.mainImageLabel"},
        permissions: {readAny: ["mainImage"], writeAny: ["mainImage"]},
        children: [
            {
                render: "#Field",
                field: {
                    name: "mainImage",
                    widget: "#MediaField",
                    label: "form.mainImageLabel",
                    widgetProps: {mediaType: "image", mode: "single"},
                },
                permissions: {read: "mainImage", write: "mainImage"},
            },
        ],
    },
    {
        render: "#TitleWithCollapse",
        props: {title: "form.imageGalleryLabel"},
        permissions: {readAny: ["imageGallery"], writeAny: ["imageGallery"]},
        children: [
            {
                render: "#Field",
                field: {
                    name: "imageGallery",
                    widget: "#MediaField",
                    label: "form.imageGalleryLabel",
                    widgetProps: {mediaType: "image", mode: "multiple", maxCount: 20},
                },
                permissions: {read: "imageGallery", write: "imageGallery"},
            },
        ],
    },
];

export const blogPostCreateFormView: ViewConfig = {
    model: "blogPosts",
    viewType: "form",
    viewMode: "create",
    accessModel: "blogPosts",
    apiUrl: "/api/auxiliary/blogPost",
    method: "PUT",
    nodes: blogPostCreateFormNodes,
};

export const blogPostEditFormView: ViewConfig = {
    model: "blogPosts",
    viewType: "form",
    viewMode: "edit",
    accessModel: "blogPosts",
    apiUrl: "/api/auxiliary/blogPost",
    method: "PATCH",
    nodes: blogPostEditFormNodes,
};

export const blogPostViews: ViewConfig[] = [
    blogPostSheetView,
    blogPostCreateFormView,
    blogPostEditFormView,
];

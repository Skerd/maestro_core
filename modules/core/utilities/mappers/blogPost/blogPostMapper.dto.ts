import type {BlogPost} from "armonia/src/modules/core/api/auxiliary/private/blogPost/blogPost.dto";
import type {IBlogPost} from "@coreModule/database/schemas/blogPost/blogPost";
import type {BlogCategorySimple} from "armonia/src/modules/core/dto/blogCategory.dto";
import {BlogCategorySimpleSnippet} from "@coreModule/database/schemas/blogCategory/blogCategory.snippets";
import {dateToISOString, mapMedia, mapSnippet} from "@coreModule/utilities/mappers/common.mapper";
import {
    mapLifeCycleToDTO,
    mapOwnershipToDTO,
    mapSoftDeleteToDTO,
} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

export function blogPostToDTO(doc: IBlogPost): BlogPost {
    const publishedAt = dateToISOString(doc.publishedAt);
    return {
        _id: doc._id.toString(),
        category: mapSnippet<BlogCategorySimple>()(doc.category, BlogCategorySimpleSnippet)!,
        title: doc.title,
        slug: doc.slug,
        excerpt: doc.excerpt ?? undefined,
        content: doc.content,
        mainImage: doc.mainImage ? mapMedia(doc.mainImage) : undefined,
        imageGallery: doc.imageGallery?.length ? doc.imageGallery.map(mapMedia) : undefined,
        published: doc.published ?? false,
        publishedAt: publishedAt || undefined,
        ...mapOwnershipToDTO(doc),
        ...mapSoftDeleteToDTO(doc),
        ...mapLifeCycleToDTO(doc),
    };
}

export function blogPostsToDTO(docs: IBlogPost[]): BlogPost[] {
    return docs.map(blogPostToDTO);
}

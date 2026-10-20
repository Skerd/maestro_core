import {nestedEntityToRef} from "@coreModule/utilities/mappers/common.mapper";

/** Public media route; serves only ids a schema marks `publicAccess` (see publicMediaPlugin). */
const PUBLIC_MEDIA_BASE = "/api/auxiliary/public/media/";

/**
 * URL a public website can load a media file from. Accepts a populated Media
 * document, a raw ObjectId or an id string; anything else gives undefined.
 */
export function publicMediaUrl(media: unknown): string | undefined {
    const id = nestedEntityToRef(media)?.toHexString();
    return id ? `${PUBLIC_MEDIA_BASE}${id}` : undefined;
}

export function publicMediaUrls(mediaList: unknown): string[] {
    if (!Array.isArray(mediaList)) {
        return [];
    }
    return mediaList
        .map((item) => publicMediaUrl(item))
        .filter((url): url is string => Boolean(url));
}

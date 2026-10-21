/**
 * Resolves demo-seed media into GridFS + `Media` documents for any module.
 *
 * Images come from Unsplash photo kits and videos from public sample URLs. Both are
 * fetched once, cached under `demo/media/` (gitignored), then uploaded with stable
 * Media `_id`s so re-seeds reuse the same rows instead of piling up copies.
 */

import {createHash} from "crypto";
import fs from "fs";
import path from "path";
import {ObjectId} from "mongodb";
import sharp from "sharp";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICompany} from "@coreModule/database/schemas/company/company";
import Media from "@coreModule/database/schemas/media/media";
import {createGridFSStorage} from "@coreModule/utilities/gridfs/gridfsStorage";

export type ResolvedDemoImages = {
    mainImageId?: ObjectId;
    galleryIds: ObjectId[];
};

const CACHE_DIR = path.resolve(__dirname, "media");
const VIDEO_CACHE_DIR = path.join(CACHE_DIR, "videos");
const FETCH_TIMEOUT_MS = 20_000;
const MAX_DEMO_VIDEO_BYTES = 20 * 1024 * 1024;
const SEED_USER_AGENT = "ArpeggioDemoSeed/1.0";

/**
 * Stable Media `_id` keyed by entity + seed + slot + source so a kit change
 * replaces the wrong hero instead of reusing a stale GridFS blob. The prefix is
 * kept from the eCommerce original so ids seeded before the move stay the same.
 */
function seedMediaId(entityKind: string, seedKey: string, galleryIndex: number, sourceId: string): ObjectId {
    const material = `ecom-marketplace-media:v1:${entityKind}:${seedKey}:g${galleryIndex}:${sourceId}`;
    const hex = createHash("sha256").update(material).digest("hex").slice(0, 24);
    return new ObjectId(hex);
}

function unsplashUrl(photoId: string, width: number, height: number): string {
    return `https://images.unsplash.com/photo-${photoId}?w=${width}&h=${height}&fit=crop&auto=format&q=80`;
}

async function loadOrFetchUnsplashImage(
    photoId: string,
    title: string,
    size: {width: number; height: number},
    logger: ReturnType<typeof getLogger>,
): Promise<{buffer: Buffer; width: number; height: number} | undefined> {
    const {width, height} = size;
    await fs.promises.mkdir(CACHE_DIR, {recursive: true});
    const cachePath = path.join(CACHE_DIR, `${photoId}-${width}x${height}.jpg`);

    if (fs.existsSync(cachePath)) {
        const buffer = await fs.promises.readFile(cachePath);
        const meta = await sharp(buffer).metadata();
        return {buffer, width: meta.width ?? width, height: meta.height ?? height};
    }

    try {
        const response = await fetch(unsplashUrl(photoId, width, height), {
            headers: {Accept: "image/*", "User-Agent": SEED_USER_AGENT},
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const raw = Buffer.from(await response.arrayBuffer());
        const buffer = await sharp(raw).resize(width, height, {fit: "cover"}).jpeg({quality: 82}).toBuffer();
        await fs.promises.writeFile(cachePath, buffer);
        return {buffer, width, height};
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        logger.warn(`Unsplash fetch failed for ${photoId}: ${message}; using placeholder.`);
        try {
            const label = title.slice(0, 28);
            const svg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2d3748"/>
      <stop offset="100%" stop-color="#4a5568"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
  <text x="${width / 2}" y="${height / 2}" fill="#edf2f7" font-family="Helvetica,Arial,sans-serif"
        font-size="36" text-anchor="middle" dominant-baseline="middle">${label.replace(/[<>&]/g, "")}</text>
</svg>`;
            // Not cached: the next seed with a network connection gets the real photo.
            const buffer = await sharp(Buffer.from(svg)).jpeg({quality: 80}).toBuffer();
            return {buffer, width, height};
        } catch {
            return undefined;
        }
    }
}

async function loadOrFetchVideo(url: string, logger: ReturnType<typeof getLogger>): Promise<Buffer | undefined> {
    await fs.promises.mkdir(VIDEO_CACHE_DIR, {recursive: true});
    const cachePath = path.join(VIDEO_CACHE_DIR, `${createHash("sha1").update(url).digest("hex")}.mp4`);
    if (fs.existsSync(cachePath)) {
        return fs.promises.readFile(cachePath);
    }

    try {
        const response = await fetch(url, {
            headers: {Accept: "video/*", "User-Agent": SEED_USER_AGENT},
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 3),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.startsWith("video/")) {
            throw new Error(`not a video (${contentType || "no content type"})`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_DEMO_VIDEO_BYTES) {
            throw new Error(`too large (${buffer.length} bytes)`);
        }
        await fs.promises.writeFile(cachePath, buffer);
        return buffer;
    } catch (e: unknown) {
        logger.warn(`Demo video skipped (${url}): ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
    }
}

async function createSeedMedia(params: {
    mediaId: ObjectId;
    type: "image" | "video";
    mimeType: string;
    extension: string;
    fileName: string;
    buffer: Buffer;
    resolution?: {width: number; height: number};
    company: ICompany;
    createdBy: ObjectId;
    uploadMeta: Record<string, string>;
    logger: ReturnType<typeof getLogger>;
}): Promise<void> {
    const {mediaId, type, mimeType, extension, fileName, buffer, resolution, company, createdBy, uploadMeta, logger} = params;
    const gridfs = createGridFSStorage("en-US", "media", logger);
    const fileId = await gridfs.uploadFile(buffer, fileName, {
        company: String(company._id),
        mediaId: mediaId.toHexString(),
        ...uploadMeta,
    });

    await Media.create({
        _id: mediaId,
        type,
        originalName: fileName,
        fileName,
        fileId,
        mimeType,
        extension,
        fileSize: buffer.length,
        sizeInBytes: buffer.length,
        metadata: {
            size: buffer.length,
            extension,
            mime: mimeType,
            safeCheckedFlag: true,
            scannedAt: new Date(),
            scannerResult: "Seeded asset — scan skipped",
            ...(resolution && {resolution}),
        },
        ...(resolution && {resolution}),
        company: company._id,
        createdBy,
        uploadedAt: new Date(),
    });
}

/**
 * Resolves Unsplash photo kits into main + gallery Media ids (products-style).
 * Idempotent on Media `_id`. Missing kits return an empty gallery.
 */
export async function resolveDemoImagesFromUnsplash(
    photoIds: readonly string[],
    seedKey: string,
    title: string,
    company: ICompany,
    createdBy: ObjectId,
    parentLogger: serverLogger,
    entityKind: string,
    size: {width: number; height: number} = {width: 800, height: 800},
): Promise<ResolvedDemoImages> {
    const logger = getLogger(`demoMedia-${entityKind}`, parentLogger);

    if (photoIds.length === 0) {
        logger.debug(`No Unsplash kit for ${seedKey}`);
        return {galleryIds: []};
    }

    const galleryIds: ObjectId[] = [];

    try {
        for (let i = 0; i < photoIds.length; i++) {
            const photoId = photoIds[i]!;
            const mediaId = seedMediaId(entityKind, seedKey, i, photoId);
            const existing = await Media.findById(mediaId).select("_id");
            if (existing) {
                galleryIds.push(mediaId);
                continue;
            }

            const image = await loadOrFetchUnsplashImage(photoId, title, size, logger);
            if (!image) {
                continue;
            }

            await createSeedMedia({
                mediaId,
                type: "image",
                mimeType: "image/jpeg",
                extension: "jpg",
                fileName: `${seedKey}-g${i}.jpg`,
                buffer: image.buffer,
                resolution: {width: image.width, height: image.height},
                company,
                createdBy,
                uploadMeta: {source: "demo-seed", photoId, tag: `${entityKind}:${seedKey}`},
                logger,
            });

            galleryIds.push(mediaId);
        }
    } catch (e: unknown) {
        logger.err(`Failed resolving Unsplash demo media for ${seedKey}: ${e instanceof Error ? e.message : String(e)}`);
    }

    return {
        mainImageId: galleryIds[0],
        galleryIds,
    };
}

/**
 * Resolves sample MP4 URLs into video Media ids, one row per company and URL, so
 * every entity of a company that shows a clip shares the same upload. A URL that
 * fails to download is left out of the map with a warning.
 */
export async function resolveDemoVideosFromUrls(
    urls: readonly string[],
    company: ICompany,
    createdBy: ObjectId,
    parentLogger: serverLogger,
): Promise<Map<string, ObjectId>> {
    const logger = getLogger("demoMedia-video", parentLogger);
    const ids = new Map<string, ObjectId>();

    try {
        for (const url of urls) {
            const mediaId = seedMediaId("video", String(company._id), 0, url);
            if (await Media.findById(mediaId).select("_id")) {
                ids.set(url, mediaId);
                continue;
            }

            const buffer = await loadOrFetchVideo(url, logger);
            if (!buffer) {
                continue;
            }

            await createSeedMedia({
                mediaId,
                type: "video",
                mimeType: "video/mp4",
                extension: "mp4",
                fileName: `demo-video-${mediaId.toHexString()}.mp4`,
                buffer,
                company,
                createdBy,
                uploadMeta: {source: "demo-seed", url},
                logger,
            });

            ids.set(url, mediaId);
        }
    } catch (e: unknown) {
        logger.err(`Failed resolving demo videos: ${e instanceof Error ? e.message : String(e)}`);
    }

    return ids;
}

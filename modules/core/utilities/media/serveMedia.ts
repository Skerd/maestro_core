/**
 * Shared utilities for serving media files securely.
 * Used by public media endpoints and protected routes (e.g. project media).
 */

import {Request, Response} from 'express';
import {ObjectId} from 'mongodb';
import {Readable} from 'stream';
import {pipeline} from 'stream/promises';
import {mediaService} from '@coreModule/database/schemas/media/media.service';
import {getLogger, serverLogger} from '@coreModule/loggers/serverLog';
import {apiValidationException} from 'armonia/src/modules/core/helpers/exceptions';
import {getGridFSStorage, GridFSStorage} from '@coreModule/utilities/gridfs/gridfsStorage';
import {IMedia} from '@coreModule/database/schemas/media/media';
import {
    HEALTH_FILE_HEADER_BYTES,
    type MediaPlaintext,
    openMediaFile,
    openMediaFileChunks,
    readSealedFileHeader,
    type SealedFile,
    sealedSpanOf,
} from '@coreModule/utilities/security/healthDataCrypto';

/**
 * Media binaries are never framed by us (PDF.js / in-app viewers fetch as bytes).
 * `frame-ancestors 'none'` is the CSP source of truth; `X-Frame-Options: DENY` is the legacy twin.
 */
const FRAME_POLICY = "none" as const;

function documentCsp(): string {
    return [
        "default-src 'none'",
        "script-src 'none'",
        "style-src 'none'",
        "img-src 'none'",
        "font-src 'none'",
        "connect-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "media-src 'none'",
        "worker-src 'none'",
        "child-src 'none'",
        `frame-ancestors '${FRAME_POLICY}'`,
    ].join('; ');
}

function mediaCsp(): string {
    return [
        "default-src 'none'",
        "script-src 'none'",
        "style-src 'none'",
        "img-src 'self' data:",
        "font-src 'none'",
        "connect-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "media-src 'self'",
        `frame-ancestors '${FRAME_POLICY}'`,
    ].join('; ');
}

/**
 * Sets security headers for file serving.
 * Framing is always denied — previews use authenticated fetches, not iframes of this URL.
 */
export function setSecurityHeaders(
    res: Response,
    mimeType: string,
    fileName: string,
    cacheControl: 'private' | 'public' = 'public',
): void {
    const isDocument = mimeType === 'application/pdf' || mimeType.includes('document') || mimeType.includes('office');
    res.setHeader('Content-Security-Policy', isDocument ? documentCsp() : mediaCsp());

    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Legacy clickjacking twin of frame-ancestors 'none'
    res.setHeader('X-Frame-Options', 'DENY');

    // XSS Protection (legacy but still useful)
    res.setHeader('X-XSS-Protection', '1; mode=block');

    // Referrer Policy
    res.setHeader('Referrer-Policy', 'no-referrer');

    // Content Type
    res.setHeader('Content-Type', mimeType);

    // Content Disposition - force download for documents and non-images
    // This prevents browsers from executing embedded scripts
    if (mimeType.startsWith('image/') || mimeType.startsWith('video/') || mimeType.startsWith('audio/')) {
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
    } else if (mimeType === 'application/pdf') {
        // PDFs can be viewed inline but with strict CSP
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
    } else {
        // Force download for all other file types (documents, archives, etc.)
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    }

    // Cache control
    res.setHeader(
        'Cache-Control',
        cacheControl === 'private'
            ? 'private, max-age=3600'
            : 'public, max-age=31536000, immutable',
    );

    // Additional security for documents
    if (mimeType === 'application/pdf' || mimeType.includes('document') || mimeType.includes('office')) {
        // Prevent PDF auto-execution
        res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    }
}

/**
 * Parses a single-range `Range: bytes=…` header against a file of `size` bytes.
 * Returns the inclusive byte range to send, "unsatisfiable" for a range that
 * starts past the end, or undefined when the header is absent, malformed or asks
 * for several ranges (the whole file is sent then, as RFC 9110 allows).
 */
export function parseByteRange(
    header: string | undefined,
    size: number,
): {start: number; end: number} | "unsatisfiable" | undefined {
    const match = header?.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (match[1] === "" && match[2] === "")) {
        return undefined;
    }
    if (match[1] === "") {
        const suffix = Number(match[2]);
        if (suffix === 0 || size === 0) {
            return "unsatisfiable";
        }
        return {start: Math.max(0, size - suffix), end: size - 1};
    }
    const start = Number(match[1]);
    const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (start >= size) {
        return "unsatisfiable";
    }
    if (end < start) {
        return undefined;
    }
    return {start, end};
}

export type ServeMediaContext = Record<string, unknown>;

/**
 * Callback to check if the user has access to the media resource.
 * When provided, it is called after fetching the media document.
 * If it returns false or throws, the request is denied.
 */
export type ServeMediaAccessCheck = (
    mediaId: ObjectId,
    media: IMedia,
    context: ServeMediaContext
) => Promise<boolean>;

export type ServeMediaOptions = {
    mediaId: string;
    req: Request;
    res: Response;
    logger?: serverLogger;
    languageCode: string;
    /** When provided, validates user has access before serving. Context is passed to the callback. */
    accessCheck?: ServeMediaAccessCheck;
    context?: ServeMediaContext;
    cacheControl?: 'private' | 'public';
    /** When access is denied, throw media_not_found instead of access_denied (public route). */
    deniedAsNotFound?: boolean;
};

async function loadMediaForServe(options: {
    mediaId: string;
    logger: serverLogger;
    languageCode: string;
    accessCheck?: ServeMediaAccessCheck;
    context?: ServeMediaContext;
    deniedAsNotFound?: boolean;
}): Promise<IMedia> {
    const {mediaId: mediaIdParam, logger, languageCode, accessCheck, context = {}, deniedAsNotFound} = options;

    if (!ObjectId.isValid(mediaIdParam)) {
        throw apiValidationException("invalid_media_id", null, null, languageCode);
    }

    const mediaId = new ObjectId(mediaIdParam);
    const media = await mediaService.findByIdOrThrow(mediaId, {logger, languageCode, withDeleted: false});

    if (accessCheck) {
        const hasAccess = await accessCheck(mediaId, media, context);
        if (!hasAccess) {
            logger.err(`Access denied for media ${mediaIdParam}`);
            throw apiValidationException(
                deniedAsNotFound ? "media_not_found" : "access_denied",
                null,
                null,
                languageCode,
            );
        }
    }

    return media;
}

/**
 * Serves a media file by ID. Validates existence, optionally checks access, streams from GridFS.
 *
 * @param options - mediaId, req, res, logger, languageCode, and optional accessCheck + context
 * @returns Promise that resolves when the stream has finished (for asyncHandler compatibility)
 * @throws apiValidationException when mediaId invalid, media not found, or access denied
 */
export async function serveMedia(options: ServeMediaOptions): Promise<void> {
    const {
        mediaId: mediaIdParam,
        req,
        res,
        logger = getLogger('serve_media'),
        languageCode,
        accessCheck,
        context = {},
        cacheControl = 'public',
        deniedAsNotFound,
    } = options;

    logger.start(`Serving media file: ${mediaIdParam}`);

    const media = await loadMediaForServe({
        mediaId: mediaIdParam,
        logger,
        languageCode,
        accessCheck,
        context,
        deniedAsNotFound,
    });

    if (!media.fileId) {
        throw apiValidationException("file_not_found", null, null, languageCode);
    }

    const gridfs = getGridFSStorage(languageCode, 'media', logger);
    const fileId = new ObjectId(String(media.fileId));
    if (media.encrypted) {
        await sendHealthFile({media, gridfs, fileId, req, res, logger});
        logger.finish(`Served health media file: ${mediaIdParam}`);
        return;
    }
    // The stored GridFS length, not the Media size fields: those can describe the upload before re-encoding.
    const size: number = (await gridfs.getFileMetadata(fileId)).length;
    const range = parseByteRange(req.headers.range, size);

    const mimeType = media.mimeType || media.metadata?.mime || 'application/octet-stream';
    const displayName = media.originalName || media.fileName || 'file';
    setSecurityHeaders(res, mimeType, displayName, cacheControl);
    // Video players (Safari/iOS always) need byte ranges to play and seek.
    res.setHeader('Accept-Ranges', 'bytes');

    if (range === "unsatisfiable") {
        res.setHeader('Content-Range', `bytes */${size}`);
        res.status(416).end();
        logger.finish(`Unsatisfiable range for media file: ${mediaIdParam}`);
        return;
    }
    if (range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
        res.setHeader('Content-Length', String(range.end - range.start + 1));
    } else {
        res.setHeader('Content-Length', String(size));
    }
    const fileStream = gridfs.downloadFile(fileId, range);

    fileStream.on('error', (error) => {
        logger.err(`Error streaming file: ${error}`);
        if (!res.headersSent) {
            res.status(500).json({error: "Error serving file"});
        }
    });

    fileStream.pipe(res);

    logger.finish(`Successfully serving media file: ${mediaIdParam}`);

    return new Promise<void>((resolve, reject) => {
        fileStream.on('end', () => resolve());
        fileStream.on('error', (error) => reject(error));
        res.on('close', () => {
            if ('destroy' in fileStream && typeof fileStream.destroy === 'function') {
                if (!('destroyed' in fileStream) || !(fileStream as NodeJS.ReadableStream & { destroyed?: boolean }).destroyed) {
                    (fileStream as NodeJS.ReadableStream & { destroy: () => void }).destroy();
                }
            }
            resolve();
        });
    });
}

async function readAll(stream: Readable): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of stream) parts.push(part);
    return Buffer.concat(parts);
}

/** A stored health file's format, read from its first bytes only. */
async function storedHealthFile(media: IMedia, gridfs: GridFSStorage, fileId: ObjectId): Promise<SealedFile> {
    const storedLength: number = (await gridfs.getFileMetadata(fileId)).length;
    const prefix = storedLength > 0
        ? await readAll(gridfs.downloadFile(fileId, {start: 0, end: Math.min(HEALTH_FILE_HEADER_BYTES, storedLength) - 1}))
        : Buffer.alloc(0);
    return readSealedFileHeader(prefix, storedLength, media.company, media._id);
}

/**
 * A health file (D102), never cached by the browser, so no plaintext copy of an X-ray stays on the reader's disk.
 * Chunked files (HFE2, TD-B101) stream: only the chunks the request covers are read, byte ranges work, and each chunk
 * is sent only after its tag verifies. The first chunk is verified before the status and headers go out, so a file
 * that is truncated, not this record's or tampered where the request starts is refused with `health_data_unreadable`
 * (409) and nothing else. A later chunk that fails cannot change the status any more: the connection is closed short
 * of the Content-Length, which the client sees as a failed, incomplete download, never as unverified bytes. Files
 * sealed whole before (HFE1) are opened whole and sent without ranges, as before.
 */
async function sendHealthFile(options: {media: IMedia; gridfs: GridFSStorage; fileId: ObjectId; req: Request; res: Response; logger: serverLogger}): Promise<void> {
    const {media, gridfs, fileId, req, res, logger} = options;
    const file = await storedHealthFile(media, gridfs, fileId);
    const setHeaders = () => {
        setSecurityHeaders(res, media.mimeType || media.metadata?.mime || 'application/octet-stream', media.originalName || media.fileName || 'file', 'private');
        res.setHeader('Cache-Control', 'no-store');
    };

    if (file.format === 1) {
        const bytes = await openMediaFile(await gridfs.getFileBuffer(fileId), media.company, media._id);
        setHeaders();
        res.setHeader('Accept-Ranges', 'none');
        res.setHeader('Content-Length', String(bytes.length));
        res.end(bytes);
        return;
    }

    const range = parseByteRange(req.headers.range, file.size);
    if (range === "unsatisfiable") {
        setHeaders();
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Range', `bytes */${file.size}`);
        res.status(416).end();
        return;
    }
    const span = sealedSpanOf(file, range);
    const chunks = openMediaFileChunks(gridfs.downloadFile(fileId, span.stored), file, media._id, span);
    const first = await chunks.next();

    setHeaders();
    res.setHeader('Accept-Ranges', 'bytes');
    if (range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
    }
    res.setHeader('Content-Length', String(span.length));
    async function* verified(): AsyncGenerator<Buffer> {
        if (!first.done) yield first.value;
        yield* chunks;
    }
    try {
        await pipeline(Readable.from(verified(), {objectMode: false}), res);
    } catch (error) {
        // The headers are out: the only signal left is ending the response short (pipeline has closed it).
        res.destroy();
        logger.warn(`Health media file ${String(media._id)} ended early: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** A media file's bytes as uploaded; health files (D102) are opened here. For server-side copies and attachments. */
export async function readMediaBytes(media: IMedia, languageCode: string): Promise<Buffer> {
    if (!media.fileId) {
        throw apiValidationException("file_not_found", null, null, languageCode);
    }
    const stored = await getGridFSStorage(languageCode, 'media').getFileBuffer(String(media.fileId));
    return media.encrypted ? openMediaFile(stored, media.company, media._id) : stored;
}

/**
 * `readMediaBytes` as a stream, for server-side copies of files too large to hold (TD-B111): read from GridFS as it is
 * pulled; a chunked health file (HFE2) is opened a chunk at a time, each only after it verifies (a chunk that does not
 * throws `health_data_unreadable` mid-stream). A health file sealed whole before (HFE1) can only be opened whole.
 */
export async function readMediaStream(media: IMedia, languageCode: string): Promise<MediaPlaintext> {
    if (!media.fileId) {
        throw apiValidationException("file_not_found", null, null, languageCode);
    }
    const gridfs = getGridFSStorage(languageCode, 'media');
    const fileId = new ObjectId(String(media.fileId));
    if (!media.encrypted) {
        return {size: (await gridfs.getFileMetadata(fileId)).length, chunks: gridfs.downloadFile(fileId)};
    }
    const file = await storedHealthFile(media, gridfs, fileId);
    if (file.format === 1) {
        const bytes = await openMediaFile(await gridfs.getFileBuffer(fileId), media.company, media._id);
        return {size: bytes.length, chunks: [bytes]};
    }
    const span = sealedSpanOf(file);
    return {size: file.size, chunks: openMediaFileChunks(gridfs.downloadFile(fileId, span.stored), file, media._id, span)};
}

export type MediaInfoDto = {
    mimeType: string;
    originalName: string;
    fileSize: number;
    type: string;
    extension: string;
};

/**
 * Metadata only — no GridFS open. Used by form previews to classify existing ObjectId media.
 */
export async function getMediaInfo(options: {
    mediaId: string;
    logger?: serverLogger;
    languageCode: string;
    accessCheck?: ServeMediaAccessCheck;
    context?: ServeMediaContext;
    deniedAsNotFound?: boolean;
}): Promise<MediaInfoDto> {
    const {
        mediaId: mediaIdParam,
        logger = getLogger('serve_media'),
        languageCode,
        accessCheck,
        context,
        deniedAsNotFound,
    } = options;

    const media = await loadMediaForServe({
        mediaId: mediaIdParam,
        logger,
        languageCode,
        accessCheck,
        context,
        deniedAsNotFound,
    });

    const mimeType = media.mimeType || media.metadata?.mime || 'application/octet-stream';
    const originalName = media.originalName || media.fileName || 'file';
    const fileSize = media.fileSize || media.sizeInBytes || media.metadata?.size || 0;
    const extension = media.extension || media.metadata?.extension || '';

    return {
        mimeType,
        originalName,
        fileSize,
        type: media.type,
        extension,
    };
}

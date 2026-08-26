/**
 * Shared utilities for serving media files securely.
 * Used by public media endpoints and protected routes (e.g. project media).
 */

import {Request, Response} from 'express';
import {ObjectId} from 'mongodb';
import {mediaService} from '@coreModule/database/schemas/media/media.service';
import {getLogger, serverLogger} from '@coreModule/loggers/serverLog';
import {apiValidationException} from 'armonia/src/modules/core/helpers/exceptions';
import {getGridFSStorage} from '@coreModule/utilities/gridfs/gridfsStorage';
import {IMedia} from '@coreModule/database/schemas/media/media';

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
export function setSecurityHeaders(res: Response, mimeType: string, fileName: string): void {
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
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    // Additional security for documents
    if (mimeType === 'application/pdf' || mimeType.includes('document') || mimeType.includes('office')) {
        // Prevent PDF auto-execution
        res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    }
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
};

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
        context = {}
    } = options;

    logger.start(`Serving media file: ${mediaIdParam}`);

    // Validate mediaId format
    if (!ObjectId.isValid(mediaIdParam)) {
        throw apiValidationException("invalid_media_id", null, null, languageCode);
    }

    const mediaId = new ObjectId(mediaIdParam);

    // Get media from database
    const media = await mediaService.findByIdOrThrow(mediaId, {logger, languageCode, withDeleted: true});

    // Access check - when provided, verify user has access to this resource
    if (accessCheck) {
        const hasAccess = await accessCheck(mediaId, media, context);
        if (!hasAccess) {
            logger.err(`Access denied for media ${mediaIdParam}`);
            throw apiValidationException("access_denied", null, null, languageCode);
        }
    }

    // Use GridFS if fileId exists
    if (!media.fileId) {
        throw apiValidationException("file_not_found", null, null, languageCode);
    }

    const gridfs = getGridFSStorage(languageCode, 'media', logger);
    const fileId = media.fileId instanceof ObjectId ? media.fileId : new ObjectId(media.fileId.toString());
    const fileStream = gridfs.downloadFile(fileId);

    const mimeType = media.mimeType || media.metadata?.mime || 'application/octet-stream';
    const displayName = media.originalName || media.fileName || 'file';
    setSecurityHeaders(res, mimeType, displayName);

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
}): Promise<MediaInfoDto> {
    const {
        mediaId: mediaIdParam,
        logger = getLogger('serve_media'),
        languageCode,
    } = options;

    if (!ObjectId.isValid(mediaIdParam)) {
        throw apiValidationException("invalid_media_id", null, null, languageCode);
    }

    const media = await mediaService.findByIdOrThrow(new ObjectId(mediaIdParam), {
        logger,
        languageCode,
        withDeleted: true,
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

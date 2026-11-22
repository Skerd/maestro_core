import {NextFunction} from 'express';
import multer, {FileFilterCallback} from 'multer';
import {ClientSession, Types as MongooseTypes} from 'mongoose';
import {getLogger, serverLogger} from '@coreModule/loggers/serverLog';
import {mediaService} from '@coreModule/database/schemas/media/media.service';
import {IMedia, IMediaMetadata} from '@coreModule/database/schemas/media/media';
import {apiValidationException} from 'armonia/src/modules/core/helpers/exceptions';
import {getGridFSStorage} from '@coreModule/utilities/gridfs/gridfsStorage';
import {FileScannerFactory} from '@coreModule/utilities/security/fileScanner';
import {isOleCompoundFile, oleEntryNames} from '@coreModule/utilities/media/oleCompoundFile';
import {Readable} from 'stream';
import path from 'path';
import sharp from 'sharp';
import {PDFArray, PDFDict, PDFDocument, PDFName, PDFObject, PDFPage} from 'pdf-lib';
import {
    ALLOWED_MIME_TYPES,
    BLOCKED_EXTENSIONS,
    BLOCKED_MIME_TYPES,
    FILE_SIGNATURES,
    UPLOAD_MIME_BY_EXTENSION
} from "armonia/src/modules/core/constants";
import {FILE_UPLOAD} from "@coreModule/environment";
import {sealMediaFileStream} from "@coreModule/utilities/security/healthDataCrypto";
import {quarantineServerKeys} from "@coreModule/utilities/middlewares/serverKeys";

export type MediaUploaded = {
    fileIds: string[];
};

/**
 * Unified Media Upload Options
 */
export interface UnifiedMediaUploadOptions {
    /** Field name in the form data (default: 'files') - for single field uploads */
    fieldName?: string;
    /** Multiple field names with their max file counts - for multi-field uploads. 
     * When provided, fieldName is ignored and files are grouped by field name.
     * Example: { mainImage: 1, imageGallery: 10, videoGallery: 10 }
     */
    fields?: Record<string, number>;
    /** Per-field MIME allowlist. Files on a listed field must match one of the types (in addition to the global allowlist). */
    fieldMimeTypes?: Record<string, string[]>;
    /** Maximum number of files (default: 10) - used when fieldName is provided */
    maxFiles?: number;
    /** Maximum file size in bytes (default: 50MB) */
    maxFileSize?: number;
    /** Whether to enable security scanning (default: true) */
    enableSecurityScan?: boolean;
    /** Whether to validate file content against MIME type using magic bytes (default: true) */
    validateFileContent?: boolean;
    /** Whether to sanitize images by re-encoding them (strips metadata and embedded scripts, requires sharp, default: true) */
    sanitizeImages?: boolean;
    /** Whether to sanitize PDFs by removing scripts, actions and embedded files (requires pdf-lib, default: true) */
    sanitizePdfs?: boolean;
    /** Whether to validate Office documents structure (default: true) */
    validateOfficeDocuments?: boolean;
    /** Whether to block Office documents with embedded macros or objects (default: true) */
    blockDangerousOfficeContent?: boolean;
    /** Whether to extract image resolution (requires sharp package, default: false) */
    extractImageResolution?: boolean;
    /** Whether to extract video/audio duration (requires ffmpeg, default: false) */
    extractMediaDuration?: boolean;
    /**
     * Marks the created Media as not yet referenced by any record (default: false). For uploads made
     * ahead of the form that will use them; `core.orphanUploadCleanup` removes any never referenced.
     */
    markPendingReference?: boolean;
    /**
     * The files are health data (SEC-06), e.g. a patient's X-rays and photos: their bytes are stored encrypted with
     * the owning company's key and opened only when an allowed reader downloads them (D102). Default: false.
     */
    healthData?: boolean;
}

/**
 * Gets file extension from filename
 */
function getFileExtension(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    return ext || '';
}

/** The extension a file of this type is stored under: the first one UPLOAD_MIME_BY_EXTENSION lists for it. */
function extensionForMime(mimeType: string): string {
    return Object.keys(UPLOAD_MIME_BY_EXTENSION).find(extension => UPLOAD_MIME_BY_EXTENSION[extension] === mimeType) ?? '';
}

/** The extensions uploads of these types may have, for messages: ".jpg, .jpeg, .png". */
function acceptedExtensions(mimeTypes: readonly string[]): string {
    return Object.keys(UPLOAD_MIME_BY_EXTENSION).filter(extension => mimeTypes.includes(UPLOAD_MIME_BY_EXTENSION[extension])).join(', ');
}

const MEGABYTE = 1024 * 1024;

/** A size limit for messages: "100 MB", or "800 KB" below a megabyte. */
function formatSizeLimit(bytes: number): string {
    return bytes >= MEGABYTE ? `${Math.floor(bytes / MEGABYTE)} MB` : `${Math.max(1, Math.floor(bytes / 1024))} KB`;
}

/** The file name with its extension replaced, or added, so the name matches the type of the stored bytes. */
function withExtension(filename: string, extension: string): string {
    const current = path.extname(filename);
    return `${current ? filename.slice(0, -current.length) : filename}${extension}`;
}

/**
 * Determines file type based on MIME type
 */
function getFileType(mimeType: string): IMedia['type'] {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType === 'application/pdf') return 'pdf';
    if (mimeType.includes('document') || mimeType.includes('word') || mimeType.includes('excel') || mimeType.includes('powerpoint')) {
        return 'document';
    }
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar') || mimeType.includes('gzip')) {
        return 'archive';
    }
    return 'other';
}

/**
 * Validates a file's type and returns the type it is checked and stored as: the one its extension names
 * (UPLOAD_MIME_BY_EXTENSION), never the browser's, so a download's name always matches what was checked.
 * Only a file without an extension keeps the browser's type, and then gets that type's extension.
 */
function validateFileType(clientMimeType: string, filename: string, languageCode: string): string {
    const extension = getFileExtension(filename);

    if (BLOCKED_EXTENSIONS.includes(extension) || BLOCKED_MIME_TYPES.includes(clientMimeType)) {
        throw apiValidationException(
            "file_type_blocked",
            null,
            null,
            languageCode
        );
    }

    const mimeType = extension ? UPLOAD_MIME_BY_EXTENSION[extension] : clientMimeType;
    if (!mimeType || !ALLOWED_MIME_TYPES.includes(mimeType)) {
        throw apiValidationException(
            "file_type_not_allowed",
            null,
            null,
            languageCode,
            [acceptedExtensions(ALLOWED_MIME_TYPES)]
        );
    }
    return mimeType;
}

/** Text has no NUL bytes, unless it is UTF-16, which opens with a byte-order mark. */
function isText(buffer: Buffer): boolean {
    const utf16 = buffer.length >= 2 && ((buffer[0] === 0xFF && buffer[1] === 0xFE) || (buffer[0] === 0xFE && buffer[1] === 0xFF));
    return utf16 || !buffer.includes(0);
}

/** Binary STL: an 80-byte header, a triangle count, then 50 bytes per triangle. ASCII STL: text opening with "solid". */
function isStl(buffer: Buffer): boolean {
    if (buffer.length >= 84 && buffer.length === 84 + 50 * buffer.readUInt32LE(80)) return true;
    return isText(buffer) && /^\s*solid\b/.test(buffer.subarray(0, 256).toString('latin1'));
}

/** Types with no fixed opening bytes, checked by their structure instead of FILE_SIGNATURES. */
const STRUCTURE_CHECKS: Partial<Record<string, (buffer: Buffer) => boolean>> = {
    'text/plain': isText,
    'text/csv': isText,
    'image/svg+xml': buffer => isText(buffer) && buffer.includes('<svg'),
    'model/stl': isStl,
};

/**
 * Validates file content against its type: magic bytes (FILE_SIGNATURES, where `null` matches any byte) or a
 * structure check. A type with neither fails closed.
 */
function contentMatchesType(buffer: Buffer, mimeType: string, logger: serverLogger): boolean {
    if (buffer.length === 0) return false;
    const structureCheck = STRUCTURE_CHECKS[mimeType];
    if (structureCheck) return structureCheck(buffer);
    const signatures = FILE_SIGNATURES[mimeType];
    if (!signatures?.length) {
        logger.warn(`[validate] No content check for MIME type: ${mimeType}`);
        return false;
    }
    return signatures.some(signature =>
        buffer.length >= signature.length && signature.every((byte, index) => byte === null || buffer[index] === byte));
}

/** An SVG is stored as a PNG at least this many pixels on its long side, so a small logo stays sharp, and at most the max. */
const SVG_RASTER_MIN_PX = 1024;
const SVG_RASTER_MAX_PX = 4096;
const SHARP_MAX_DENSITY = 100_000;

/**
 * Sanitizes an image by re-encoding it, which strips metadata and anything embedded. Photos are turned upright first
 * (their EXIF orientation is dropped with the metadata), GIF and WebP keep their animation, and an SVG becomes a PNG.
 * Returns the type of the bytes it produced.
 */
async function sanitizeImageBuffer(inputBuffer: Buffer, mimeType: string): Promise<{buffer: Buffer; mimeType: string; resolution?: {width: number; height: number}}> {
    try {
        let pipeline: sharp.Sharp;
        let outputMimeType = mimeType;
        if (mimeType === 'image/jpeg') {
            pipeline = sharp(inputBuffer).rotate().jpeg({quality: 90, mozjpeg: true});
        }
        else if (mimeType === 'image/png') {
            pipeline = sharp(inputBuffer).rotate().png({quality: 90, compressionLevel: 9});
        }
        else if (mimeType === 'image/webp') {
            pipeline = sharp(inputBuffer, {animated: true}).webp({quality: 90});
        }
        else if (mimeType === 'image/gif') {
            pipeline = sharp(inputBuffer, {animated: true}).gif();
        }
        else if (mimeType === 'image/svg+xml') {
            const {width = 0, height = 0} = await sharp(inputBuffer).metadata();
            const longSide = Math.max(width, height);
            if (!longSide) throw new Error('The SVG has no size');
            const targetSide = Math.min(Math.max(longSide, SVG_RASTER_MIN_PX), SVG_RASTER_MAX_PX);
            const density = Math.min(72 * targetSide / longSide, SHARP_MAX_DENSITY);
            pipeline = sharp(inputBuffer, {density}).png({compressionLevel: 9});
            outputMimeType = 'image/png';
        }
        else {
            // Any other image type is stored as a JPEG.
            pipeline = sharp(inputBuffer).rotate().jpeg({quality: 90, mozjpeg: true});
            outputMimeType = 'image/jpeg';
        }

        const sanitizedBuffer = await pipeline.toBuffer();
        const metadata = await sharp(sanitizedBuffer).metadata();
        const resolution = metadata.width && metadata.height ? {
            width: metadata.width,
            height: metadata.height
        } : undefined;

        return {
            buffer: sanitizedBuffer,
            mimeType: outputMimeType,
            resolution
        };
    } catch (error) {
        throw new Error(`Failed to sanitize image: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** Annotation kinds that carry files or media players; a cleaned PDF drops them. */
const PDF_REMOVED_ANNOTATIONS = new Set(['FileAttachment', 'RichMedia', 'Screen', 'Movie', 'Sound', '3D']);
/** The only actions a cleaned PDF keeps: links to a web address or to a place in the document. */
const PDF_KEPT_ACTIONS = new Set(['URI', 'GoTo']);
/** How far up a form widget's field tree its actions are removed. */
const PDF_MAX_FIELD_DEPTH = 10;

/** Strips a copied page of what runs by itself or launches something: page, link and form actions, embedded files and media. */
function stripPdfPageActions(pdf: PDFDocument, page: PDFPage): void {
    page.node.delete(PDFName.of('AA'));
    const annotations = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annotations) return;

    const kept: PDFObject[] = [];
    for (let index = 0; index < annotations.size(); index++) {
        const entry = annotations.get(index);
        const annotation = pdf.context.lookupMaybe(entry, PDFDict);
        if (!annotation) continue;
        const subtype = annotation.lookupMaybe(PDFName.of('Subtype'), PDFName);
        if (subtype && PDF_REMOVED_ANNOTATIONS.has(subtype.decodeText())) continue;

        // A form widget's actions can also sit on the fields above it.
        let node: PDFDict | undefined = annotation;
        for (let depth = 0; node && depth < PDF_MAX_FIELD_DEPTH; depth++) {
            node.delete(PDFName.of('AA'));
            const action = node.lookupMaybe(PDFName.of('A'), PDFDict);
            const kind = action?.lookupMaybe(PDFName.of('S'), PDFName)?.decodeText();
            if (action && kind && PDF_KEPT_ACTIONS.has(kind)) action.delete(PDFName.of('Next'));
            else node.delete(PDFName.of('A'));
            node = node.lookupMaybe(PDFName.of('Parent'), PDFDict);
        }
        kept.push(entry);
    }
    page.node.set(PDFName.of('Annots'), pdf.context.obj(kept));
}

/**
 * Sanitizes a PDF: its pages are copied into a new document, which leaves behind document-level scripts, open
 * actions and attachments, and each page is stripped of its actions. pdf-lib cannot decrypt, so an encrypted PDF
 * (often only owner-locked, like bank statements, which open without a password) is kept as uploaded; the virus scan
 * has already run on it.
 */
async function sanitizePdfBuffer(inputBuffer: Buffer, logger: serverLogger): Promise<Buffer> {
    try {
        const source = await PDFDocument.load(inputBuffer, {ignoreEncryption: true});
        if (source.isEncrypted) {
            logger.warn('Encrypted PDF stored as uploaded, without script cleaning');
            return inputBuffer;
        }

        const cleanPdf = await PDFDocument.create();
        const pages = await cleanPdf.copyPages(source, source.getPageIndices());
        for (const page of pages) {
            cleanPdf.addPage(page);
            stripPdfPageActions(cleanPdf, page);
        }
        return Buffer.from(await cleanPdf.save());
    } catch (error) {
        throw new Error(`Failed to sanitize PDF: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** Files that run code when opened, anywhere inside an Office document. */
const OFFICE_EXECUTABLE_ENTRY = /\.(exe|dll|ocx|scr|com|msi|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|jar|lnk)$/;
/** Relationships that make Office fetch an object, a template or a frame from elsewhere when the file opens. */
const OFFICE_FETCHED_RELATIONSHIP = /\/(oleObject|attachedTemplate|frame|subDocument)$/;
/** OLE2 entries that hold VBA macros, a packaged file, or an Equation Editor 3.0 object (a long-exploited component). */
const OLE_DANGEROUS_ENTRIES = new Map<string, string>([
    ['macros', 'macros'], ['_vba_project_cur', 'macros'], ['_vba_project', 'macros'], ['vba', 'macros'],
    ['\u0001ole10native', 'an embedded file'], ['equation native', 'an Equation Editor object'],
]);
/** The largest part of an Office file unpacked for inspection; a bigger one is refused rather than unpacked. */
const OFFICE_PART_MAX_BYTES = 50 * 1024 * 1024;
/** How deep objects embedded in objects are followed. */
const OFFICE_MAX_NESTING = 2;
const ZIP_ENTRY_SIGNATURE = Buffer.from([0x50, 0x4B, 0x03, 0x04]);

function relationshipFetchesExternally(relationshipsXml: string): boolean {
    return (relationshipsXml.match(/<Relationship\b[^>]*>/g) ?? []).some(tag =>
        /TargetMode\s*=\s*"External"/i.test(tag) && OFFICE_FETCHED_RELATIONSHIP.test(/Type\s*=\s*"([^"]*)"/.exec(tag)?.[1] ?? ''));
}

/**
 * What makes an Office document unsafe to accept: macros, ActiveX controls, packaged files, executables, or objects
 * and templates fetched from elsewhere. Charts (an embedded workbook) and printer settings are fine, and embedded
 * objects are checked by the same rules. Office 97-2003 files are OLE2 containers, checked by their entry names;
 * PowerPoint 97-2003 keeps macros inside a compressed stream, which ClamAV checks (AlertOLE2Macros).
 * Throws when the file cannot be read.
 */
function officeDocumentProblems(buffer: Buffer, depth: number = 0): string[] {
    if (isOleCompoundFile(buffer)) {
        return [...new Set(oleEntryNames(buffer).flatMap(name => OLE_DANGEROUS_ENTRIES.get(name.toLowerCase()) ?? []))];
    }

    const AdmZip = require('adm-zip');
    const problems: string[] = [];
    for (const entry of new AdmZip(buffer).getEntries()) {
        if (entry.isDirectory) continue;
        const name: string = entry.entryName;
        const lowerName = name.toLowerCase();
        const unpack = (): Buffer => {
            if (entry.header.size > OFFICE_PART_MAX_BYTES) throw new Error(`${name} is too large to inspect`);
            return entry.getData();
        };

        if (/(^|\/)vbaproject\.bin$|(^|\/)vbadata\.xml$/.test(lowerName)) {
            problems.push(`macros (${name})`);
        }
        else if (/(^|\/)activex\//.test(lowerName)) {
            problems.push(`an ActiveX control (${name})`);
        }
        else if (OFFICE_EXECUTABLE_ENTRY.test(lowerName)) {
            problems.push(`an executable (${name})`);
        }
        else if (/(^|\/)embeddings\//.test(lowerName)) {
            if (depth >= OFFICE_MAX_NESTING) {
                problems.push(`objects nested too deeply (${name})`);
                continue;
            }
            const data = unpack();
            if (data.subarray(0, 4).equals(ZIP_ENTRY_SIGNATURE) || isOleCompoundFile(data)) {
                problems.push(...officeDocumentProblems(data, depth + 1).map(problem => `${problem} in ${name}`));
            } else {
                problems.push(`an embedded object of unknown kind (${name})`);
            }
        }
        else if (lowerName === '[content_types].xml' && /vbaProject|macroEnabled/i.test(unpack().toString('utf8'))) {
            problems.push('macros (declared in [Content_Types].xml)');
        }
        else if (lowerName.endsWith('.rels') && relationshipFetchesExternally(unpack().toString('utf8'))) {
            problems.push(`content fetched from elsewhere (${name})`);
        }
    }
    return problems;
}

/**
 * Extracts image resolution from buffer (optional - requires sharp package)
 */
async function getImageResolutionFromBuffer(buffer: Buffer): Promise<{width: number; height: number} | undefined> {

    try {
        const metadata = await sharp(buffer).metadata();
        if (metadata.width && metadata.height) {
            return {
                width: metadata.width,
                height: metadata.height
            };
        }
    } catch (error) {
        // Sharp not available or error - silently fail
    }
    return undefined;
}

/**
 * Extracts media duration from buffer (video/audio)
 * 
 * Uses music-metadata library which works with buffers and supports:
 * - Audio: MP3, WAV, OGG, FLAC, AAC, M4A, etc.
 * - Video: MP4, M4V, MOV, WebM, etc.
 * 
 * Falls back to fluent-ffmpeg for video files if music-metadata fails
 * (requires ffmpeg to be installed on the system).
 * 
 * @param buffer - File buffer
 * @param mimeType - MIME type of the file
 * @param logger - Logger instance for error reporting
 * @returns Duration in seconds, or undefined if extraction fails
 */
async function extractMediaDurationFromBuffer(buffer: Buffer, mimeType: string, logger: serverLogger): Promise<number | undefined> {
    // Primary method: music-metadata (pure JS, works with buffers, no system dependencies)
    try {
        const {parseBuffer} = require('music-metadata');
        const metadata = await parseBuffer(buffer);
        
        if (metadata.format && metadata.format.duration && metadata.format.duration > 0) {
            const duration = Math.round(metadata.format.duration);
            logger.debug(`Extracted duration using music-metadata: ${duration} seconds`);
            return duration;
        }
    } catch (musicMetadataError: any) {
        // music-metadata not available or failed - try fallback for video files
        logger.debug(`music-metadata failed: ${musicMetadataError.message || musicMetadataError}`);
        
        // Fallback for video files: use fluent-ffmpeg (requires ffmpeg installed)
        if (mimeType.startsWith('video/')) {
            try {
                const ffmpeg = require('fluent-ffmpeg');
                const fs = require('fs');
                const path = require('path');
                const os = require('os');
                
                // Create temporary file for ffmpeg (it needs a file path, not a buffer)
                const tempDir = os.tmpdir();
                const fileExtension = path.extname(mimeType.split('/')[1]) || '.mp4';
                const tempFilePath = path.join(tempDir, `temp_${Date.now()}_${Math.random().toString(36).substring(7)}${fileExtension}`);
                
                // Write buffer to temp file
                await fs.promises.writeFile(tempFilePath, buffer);
                
                // Get duration using ffprobe
                const duration = await new Promise<number | undefined>((resolve) => {
                    ffmpeg.ffprobe(tempFilePath, (err: any, metadata: any) => {
                        // Clean up temp file immediately
                        fs.promises.unlink(tempFilePath).catch(() => {});
                        
                        if (err || !metadata || !metadata.format || !metadata.format.duration) {
                            resolve(undefined);
                            return;
                        }
                        
                        const duration = Math.round(metadata.format.duration);
                        logger.debug(`Extracted duration using ffmpeg: ${duration} seconds`);
                        resolve(duration);
                    });
                });
                
                return duration;
            } catch (ffmpegError: any) {
                // ffmpeg not available or failed - log and return undefined
                logger.debug(`ffmpeg fallback failed: ${ffmpegError.message || ffmpegError}`);
                return undefined;
            }
        }
    }
    
    return undefined;
}

type StoredUpload = {gridfsFileId: string; mediaId: MongooseTypes.ObjectId};

/**
 * Deletes what a failed request already stored. Without a transaction nothing rolls back, and these Media records are
 * not marked `pendingReference`, so `core.orphanUploadCleanup` would never remove them.
 */
async function discardStoredUploads(uploads: StoredUpload[], languageCode: string, logger: serverLogger): Promise<void> {
    if (uploads.length === 0) return;
    try {
        await mediaService.deleteMany({_id: {$in: uploads.map(upload => upload.mediaId)}}, {hard: true, logger});
    } catch (error: any) {
        logger.warn(`Failed to delete the Media records of a failed upload: ${error.message}`);
    }
    const gridfs = getGridFSStorage(languageCode, 'media', logger);
    for (const upload of uploads) {
        try {
            await gridfs.deleteFile(upload.gridfsFileId);
        } catch (error: any) {
            logger.warn(`Failed to delete GridFS file ${upload.gridfsFileId} of a failed upload: ${error.message}`);
        }
    }
}

/**
 * Unified Media Upload Middleware
 *
 * Handles all file uploads using multer (memory storage), validates files,
 * scans for security threats, sanitizes content, and stores in GridFS.
 * This is the single, unified middleware for all media uploads in the application.
 * 
 * **Security Features:**
 * - **File Type Validation**: The extension decides the type (UPLOAD_MIME_BY_EXTENSION); blocked or unlisted types are refused
 * - **File Content Validation**: Validates actual file content against that type (magic bytes or structure)
 * - **Security Scanning**: Pluggable scanner (ClamAV, or the mock, which scans nothing and records files as not scanned)
 * - **Image Sanitization**: Re-encodes images to strip metadata and embedded scripts (requires sharp)
 * - **PDF Sanitization**: Removes scripts, actions and embedded files from PDFs (requires pdf-lib)
 * - **Office Document Validation**: Blocks macros, ActiveX, packaged files and externally fetched content (adm-zip, OLE2 reader)
 * - **Rejections reach the caller**: a refused file fails the request; nothing is dropped silently, and files already
 *   stored by a failed request are deleted
 * - **GridFS Storage**: Stores files in MongoDB GridFS for scalability
 * - **Metadata Extraction**: Extracts image resolution, video/audio duration
 * 
 * @param options - Configuration options for file upload
 * @returns Express middleware function
 * 
 * @example
 * ```typescript
 * // Basic usage (single field)
 * router.post(
 *     "/upload",
 *     authMW("private"),
 *     mediaUploadMW(),
 *     asyncHandler(uploadHandler)
 * );
 * 
 * // Secure configuration for images only (single field)
 * router.post(
 *     "/upload",
 *     authMW("private"),
 *     mediaUploadMW({
 *         fieldName: 'images',
 *         maxFiles: 5,
 *         maxFileSize: 5 * 1024 * 1024, // 5MB
 *         sanitizeImages: true,
 *         validateFileContent: true
 *     }),
 *     asyncHandler(uploadHandler)
 * );
 * 
 * // Multi-field mode (recommended for projects with mainImage, imageGallery, videoGallery)
 * router.post(
 *     "/upload",
 *     authMW("private"),
 *     mediaUploadMW({
 *         fields: {
 *             mainImage: 1,        // 1 file max
 *             imageGallery: 10,    // 10 files max
 *             videoGallery: 10     // 10 files max
 *         },
 *         maxFileSize: 100 * 1024 * 1024, // 100MB
 *         sanitizeImages: true
 *     }),
 *     asyncHandler(uploadHandler)
 * );
 * 
 * // In the handler, files are automatically grouped:
 * // req.body.mainImage = "fileId" (single file, so just the ID string)
 * // req.body.imageGallery = ["fileId1", "fileId2", ...] (array of IDs)
 * // req.body.videoGallery = ["fileId1", "fileId2", ...] (array of IDs)
 * ```
 */
export function mediaUploadMW(options: UnifiedMediaUploadOptions = {}) {
    const {
        fieldName = 'files',
        fields,
        fieldMimeTypes,
        maxFiles = FILE_UPLOAD.MAX_FILES_UPLOADED,
        maxFileSize = FILE_UPLOAD.MAX_FILE_SIZE,
        enableSecurityScan = true,
        validateFileContent = true,
        sanitizeImages = true,
        sanitizePdfs = true,
        validateOfficeDocuments = true,
        blockDangerousOfficeContent = true,
        extractImageResolution = true,
        extractMediaDuration = true,
        markPendingReference = false,
        healthData = false
    } = options;

    // Configure multer with memory storage (we'll stream to GridFS)
    const storage = multer.memoryStorage();

    // Configure file filter
    const fileFilter = (req: any, file: Express.Multer.File, cb: FileFilterCallback) => {
        const languageCode = req.header("language") || "en-US";
        
        try {
            // Never trust client MIME type: the extension decides it, and the bytes are checked against it later.
            file.mimetype = validateFileType(file.mimetype, file.originalname, languageCode);
            if (!getFileExtension(file.originalname)) {
                file.originalname = withExtension(file.originalname, extensionForMime(file.mimetype));
            }
            const allowedForField = fieldMimeTypes?.[file.fieldname];
            if (allowedForField?.length && !allowedForField.includes(file.mimetype)) {
                throw apiValidationException(
                    "file_type_not_allowed",
                    null,
                    null,
                    languageCode,
                    [acceptedExtensions(allowedForField)]
                );
            }
            cb(null, true);
        } catch (error: any) {
            // Log file rejection for debugging
            const logger = req.body?.logger || getLogger("unified_media_upload");
            logger.warn(`File rejected by filter: ${file.originalname} (${file.mimetype}, fieldname: ${file.fieldname}) - ${error.message || error}`);
            cb(error);
        }
    };

    // Configure multer
    const upload = multer({
        storage,
        limits: {
            fileSize: maxFileSize,
            files: maxFiles
        },
        fileFilter
    });

    // Return middleware function
    return async (req: any, res: any, next: NextFunction) => {
        const logger: serverLogger = req.body?.logger || getLogger("unified_media_upload");
        const session: ClientSession | undefined = req.body?.session;
        const languageCode = req.header("language") || "en-US";
        const storedUploads: StoredUpload[] = [];

        try {
            logger.start("Processing unified media upload...");

            // Preserve existing req.body data before multer processes the request
            // Multer will overwrite req.body with form fields, so we need to merge it back
            const bodyBeforeUpload = req.body;
            const existingBody = { ...req.body };
            let files: Express.Multer.File[] = [];
            let filesByField: Record<string, Express.Multer.File[]> = {};

            // Use multer to handle file upload (memory storage)
            let multerMiddleware;

            if (fields) {
                // Multi-field mode: use fields() to handle multiple field names
                const fieldsArray = Object.entries(fields).map(([name, maxCount]) => ({
                    name,
                    maxCount
                }));
                multerMiddleware = upload.fields(fieldsArray);
                logger.debug(`Using multi-field mode with fields: ${Object.keys(fields).join(', ')}`);
            }
            else {
                // Single field mode: use array() for backward compatibility
                multerMiddleware = upload.array(fieldName, maxFiles);
                logger.debug(`Using single-field mode with field: ${fieldName}`);
            }

            // A file refused while reading the request (type, size, count) fails the whole request, so the caller
            // learns why instead of seeing the other files saved without it.
            await new Promise<void>((resolve, reject) => {
                multerMiddleware(req, res, (err: any) => {
                    if (err) {
                        if (err.code === 'LIMIT_FILE_SIZE') {
                            return reject(apiValidationException("file_too_large", null, null, languageCode, [formatSizeLimit(maxFileSize)]));
                        }
                        // Multer reports a field over its maxCount as an unexpected file.
                        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
                            return reject(apiValidationException("too_many_files", null, null, languageCode));
                        }
                        return reject(err);
                    }
                    resolve();
                });
            });

            // Clean up: Remove string "null" values that multer may have set from form data
            if (fields) {
                Object.keys(fields).forEach(field => {
                    if (req.body[field] === "null") {
                        delete req.body[field];
                    }
                });
            }

            // Restore and merge existing body data with multer's processed body
            // Multer may have added form fields to req.body, so we merge both
            // IMPORTANT: Parse JSON data first, then we'll overwrite with file IDs after processing

            let data = req.body?.data || "{}";
            const jsonData = JSON.parse(data);
            
            // Store original JSON values for reference (before file processing overwrites them)
            const originalJsonValues: Record<string, any> = {};
            if (fields) {
                Object.keys(fields).forEach(field => {
                    if (jsonData[field] !== undefined) {
                        originalJsonValues[field] = jsonData[field];
                    }
                });
            }

            // The form's fields and its `data` JSON are client input that arrives after stripServerKeys has run, so
            // server keys in them are quarantined the same way and never replace what authMW wrote (SEC-03).
            // Multer replaces the body only for a multipart request; a JSON body was already cleaned.
            const formFields = req.body === bodyBeforeUpload ? {} : req.body;
            const clientFields: Record<string, unknown> = {...formFields, ...jsonData};
            quarantineServerKeys(req, clientFields);
            req.body = {
                ...existingBody,
                ...clientFields
            };

            // Extract files based on mode
            if (fields) {
                // Multi-field mode: files are in req.files as an object
                filesByField = (req.files as Record<string, Express.Multer.File[]>) || {};
                // Log what multer received
                logger.debug(`Multer received files by field: ${JSON.stringify(Object.keys(filesByField).map(key => `${key}(${filesByField[key]?.length || 0})`))}`);
                Object.entries(filesByField).forEach(([fieldName, fieldFiles]) => {
                    fieldFiles.forEach((file, idx) => {
                        logger.debug(`  ${fieldName}[${idx}]: ${file.originalname} (${file.mimetype}, ${file.size} bytes, fieldname: ${file.fieldname})`);
                    });
                });
                // Flatten all files for processing
                files = Object.values(filesByField).flat();
            }
            else {
                // Single field mode: files are in req.files as an array
                files = (req.files as Express.Multer.File[]) || [];
            }
            
            if (!files || files.length === 0) {
                logger.finish("No files uploaded");
                if (fields) {
                    // Preserve existing values from JSON if no files are uploaded
                    // Don't overwrite existing ObjectIds with empty arrays
                    Object.keys(fields).forEach(field => {
                        // Only set empty array if field doesn't exist in JSON
                        // If it exists in JSON (existing ObjectId), preserve it
                        if (req.body[field] === undefined) {
                            const fieldMaxCount = fields[field];
                            req.body[field] = fieldMaxCount === 1 ? undefined : [];
                        }
                    });
                } else {
                    req.body.fileIds = [];
                }
                return next();
            }

            logger.debug(`Processing ${files.length} file(s)...`);

            // Initialize GridFS and security scanner
            const gridfs = getGridFSStorage(languageCode, 'media', logger);
            const scanner = enableSecurityScan ? FileScannerFactory.createScanner(logger) : null;

            // When using a transaction session, track GridFS file IDs for cleanup on rollback
            // (GridFS doesn't participate in MongoDB transactions, so we compensate by deleting on abort)
            if (session) {
                req.body._mediaUploadGridFsIds = [];
            }

            // Group files by field name for multi-field mode
            const fileIdsByField: Record<string, string[]> = {};
            if (fields) {
                Object.keys(fields).forEach(field => {
                    fileIdsByField[field] = [];
                });
            }
            
            // For backward compatibility, also maintain a flat fileIds array
            const fileIds: string[] = [];
            const userId = req.body.userInfo._id;

            // Process each file
            for (const file of files) {
                try {
                    const fileType = getFileType(file.mimetype);
                    const fileBuffer = file.buffer;

                    logger.debug(`Processing file: ${file.originalname} (${file.mimetype}, ${file.size} bytes)`);

                    // Security: Validate file content against its type (magic bytes or structure)
                    if (validateFileContent) {
                        const isValid = contentMatchesType(fileBuffer, file.mimetype, logger);
                        if (!isValid) {
                            throw apiValidationException(
                                "file_content_does_not_match_type",
                                null,
                                null,
                                languageCode
                            );
                        }
                    }

                    // Security: Scan file for threats
                    let scanResult = null;
                    if (scanner && scanner.isAvailable()) {
                        try {
                            scanResult = await scanner.scanFile(file.originalname, fileBuffer);
                            logger.debug(`Security scan result for ${file.originalname}: ${scanResult.safe ? 'SAFE' : 'THREAT DETECTED'}`);
                            
                            // A threat found and a scan that could not run read differently to the user.
                            if (!scanResult.safe && scanResult.scanned) {
                                throw apiValidationException(
                                    "file_contains_malware",
                                    null,
                                    null,
                                    languageCode,
                                    [scanResult.threat ?? '?']
                                );
                            }
                            if (!scanResult.safe) {
                                throw apiValidationException(
                                    "file_security_scan_failed",
                                    null,
                                    null,
                                    languageCode
                                );
                            }
                        }
                        catch (scanError: any) {
                            if (scanError.error_code) {
                                throw scanError; // Re-throw API exceptions
                            }
                            logger.err(`Security scan error for ${file.originalname}:`, scanError);
                            throw apiValidationException(
                                "file_security_scan_failed",
                                null,
                                null,
                                languageCode
                            );
                        }
                    }

                    // Process file buffer (sanitization, validation)
                    let processedBuffer = fileBuffer;
                    let resolution: {width: number; height: number} | undefined;
                    let durationInSeconds: number | undefined;

                    // SECURITY: Sanitize images by re-encoding them (strips metadata and embedded scripts)
                    if (sanitizeImages && fileType === 'image') {
                        try {
                            const sanitized = await sanitizeImageBuffer(processedBuffer, file.mimetype);
                            processedBuffer = sanitized.buffer;
                            if (sanitized.resolution) {
                                resolution = sanitized.resolution;
                            }
                            // An SVG is stored as a PNG: the stored type and name follow the bytes.
                            if (sanitized.mimeType !== file.mimetype) {
                                file.mimetype = sanitized.mimeType;
                                file.originalname = withExtension(file.originalname, extensionForMime(sanitized.mimeType));
                            }
                            logger.debug(`Sanitized image: ${file.originalname}`);
                        }
                        catch (sanitizeError: any) {
                            logger.err(`Error sanitizing image ${file.originalname}:`, sanitizeError);
                            throw apiValidationException(
                                "image_sanitization_failed",
                                null,
                                null,
                                languageCode
                            );
                        }
                    }
                    else if (extractImageResolution && fileType === 'image') {
                        // Only extract resolution if not sanitizing (sanitization already extracts it)
                        const extractedRes = await getImageResolutionFromBuffer(processedBuffer);
                        if (extractedRes) {
                            resolution = extractedRes;
                        }
                    }

                    // SECURITY: Sanitize PDFs by removing JavaScript and embedded objects
                    if (sanitizePdfs && fileType === 'pdf') {
                        try {
                            processedBuffer = await sanitizePdfBuffer(processedBuffer, logger);
                            logger.debug(`Sanitized PDF: ${file.originalname}`);
                        }
                        catch (sanitizeError: any) {
                            logger.err(`Error sanitizing PDF ${file.originalname}:`, sanitizeError);
                            throw apiValidationException(
                                "pdf_sanitization_failed",
                                null,
                                null,
                                languageCode
                            );
                        }
                    }

                    // SECURITY: Office documents (.docx/.xlsx/.pptx and the 97-2003 .doc/.xls/.ppt)
                    if (validateOfficeDocuments && fileType === 'document') {
                        let problems: string[];
                        try {
                            problems = officeDocumentProblems(processedBuffer);
                        }
                        catch (readError: any) {
                            logger.err(`Error reading Office document ${file.originalname}:`, readError);
                            throw apiValidationException(
                                "office_document_validation_failed",
                                null,
                                null,
                                languageCode
                            );
                        }

                        if (problems.length > 0) {
                            logger.warn(`Office document ${file.originalname} contains ${problems.join('; ')}`);
                            if (blockDangerousOfficeContent) {
                                throw apiValidationException(
                                    "office_document_validation_failed",
                                    null,
                                    null,
                                    languageCode
                                );
                            }
                        }
                    }

                    // Extract video/audio duration
                    if (extractMediaDuration && (fileType === 'video' || fileType === 'audio')) {
                        try {
                            const extractedDuration = await extractMediaDurationFromBuffer(processedBuffer, file.mimetype, logger);
                            if (extractedDuration !== undefined && extractedDuration > 0) {
                                durationInSeconds = extractedDuration;
                                logger.debug(`Extracted duration for ${file.originalname}: ${durationInSeconds} seconds`);
                            } else {
                                logger.debug(`Could not extract duration for ${file.originalname} - duration will be undefined`);
                            }
                        } catch (durationError: any) {
                            // Duration extraction failed - log but don't fail the upload (it's optional metadata)
                            logger.warn(`Failed to extract duration for ${file.originalname}: ${durationError.message || durationError}`);
                            // Continue without duration - it's optional metadata
                        }
                    }

                    const extension = getFileExtension(file.originalname);
                    // Health files are sealed for this Media record before anything is stored (D102).
                    const newMediaId = new MongooseTypes.ObjectId();
                    // The Media record's company (below), whose key seals it.
                    const ownerCompany = req.body?.user?.company?._id ?? req.body?.company?._id;
                    // Uploads are buffered (memoryStorage), so a health file is sealed chunk by chunk as GridFS pulls it (TD-B101).
                    const fileStream = healthData ? await sealMediaFileStream(processedBuffer, ownerCompany, newMediaId) : Readable.from(processedBuffer);

                    // Upload processed file to GridFS
                    const gridfsFileId = await gridfs.uploadFile(
                        fileStream,
                        file.originalname,
                        {
                            mimeType: file.mimetype,
                            uploadedBy: userId?.toString(),
                            uploadedAt: new Date().toISOString()
                        }
                    );

                    // Track for rollback cleanup (GridFS files are not transactional)
                    if (session && req.body._mediaUploadGridFsIds) {
                        req.body._mediaUploadGridFsIds.push(gridfsFileId.toString());
                    }
                    storedUploads.push({gridfsFileId: gridfsFileId.toString(), mediaId: newMediaId});

                    // Create metadata object
                    const metadata: IMediaMetadata = {
                        size: processedBuffer.length, // Use processed buffer size (may differ after sanitization)
                        extension,
                        mime: file.mimetype,
                        safeCheckedFlag: scanResult?.scanned ? scanResult.safe : false,
                        scannedAt: scanResult?.scanned ? new Date() : undefined,
                        scannerResult: scanResult?.result,
                        ...(resolution && {resolution}),
                        ...(durationInSeconds && {durationInSeconds})
                    };

                    // Convert MongoDB ObjectId to Mongoose ObjectId
                    const mongooseFileId = new MongooseTypes.ObjectId(gridfsFileId.toString());

                    // Create Media document
                    const mediaData: Partial<IMedia> = {
                        _id: newMediaId,
                        type: fileType,
                        originalName: file.originalname,
                        fileName: file.originalname, // Keep original name for display
                        fileId: mongooseFileId as any, // Type assertion needed due to MongoDB vs Mongoose ObjectId types
                        createdBy: userId as any, // Type assertion for Mongoose ObjectId (ownershipPlugin)
                        ...(req.body?.user?.company && { company: req.body?.user?.company?._id as any }),
                        ...(healthData && { company: ownerCompany }),
                        ...(markPendingReference && { pendingReference: true }),
                        ...(healthData && { encrypted: true }),
                        metadata,
                        // Legacy fields for backward compatibility
                        mimeType: file.mimetype,
                        extension,
                        fileSize: processedBuffer.length,
                        sizeInBytes: processedBuffer.length,
                        ...(resolution && {resolution}),
                        ...(durationInSeconds && {durationInSeconds})
                    };

                    const media = await mediaService.create(mediaData, {
                        session,
                        logger,
                        languageCode
                    });

                    const mediaId = media._id.toString();
                    
                    // Add to appropriate field group
                    if (fields && file.fieldname) {
                        // Multi-field mode: add to the field's array
                        if (fileIdsByField[file.fieldname]) {
                            fileIdsByField[file.fieldname].push(mediaId);
                        } else {
                            // Field name not in expected fields, but we'll still add it
                            if (!fileIdsByField[file.fieldname]) {
                                fileIdsByField[file.fieldname] = [];
                            }
                            fileIdsByField[file.fieldname].push(mediaId);
                            logger.warn(`File uploaded with unexpected field name: ${file.fieldname}`);
                        }
                    }
                    
                    // Also add to flat array for backward compatibility
                    fileIds.push(mediaId);
                    
                    logger.debug(`Created Media document for file: ${file.originalname} (ID: ${media._id}, GridFS: ${gridfsFileId}, field: ${file.fieldname || fieldName})`);

                } catch (fileError: any) {
                    logger.err(`Error processing file ${file.originalname}:`, fileError);
                    throw fileError;
                    // Continue processing other files, but log the error
                    // The endpoint can decide whether to fail entirely or return partial success
                }
            }

            // Attach fileIds to request body
            if (fields) {
                // Multi-field mode: attach each field's file IDs
                // For fields with uploaded files, merge with existing JSON values (for edit operations)
                Object.keys(fields).forEach(field => {
                    const uploadedIds = fileIdsByField[field] || [];

                    // Resolve existing IDs from two possible sources:
                    // 1. req.body.data JSON blob (mapSubmitPayload pattern)
                    // 2. individual FormData text field (withAxios auto-extract pattern, no mapSubmitPayload)
                    //    In the auto-extract pattern arrays are JSON.stringify-ed by appendFormDataValue.
                    let existingIds = originalJsonValues[field];
                    if (existingIds === undefined) {
                        const bodyValue = req.body[field];
                        if (bodyValue !== undefined && bodyValue !== null) {
                            if (typeof bodyValue === 'string') {
                                try { existingIds = JSON.parse(bodyValue); } catch { existingIds = bodyValue; }
                            } else {
                                existingIds = bodyValue;
                            }
                        }
                    }

                    if (uploadedIds.length > 0) {
                        // Files were uploaded for this field
                        const fieldMaxCount = fields[field];
                        if (fieldMaxCount === 1) {
                            // Single file field: use the uploaded file ID (overwrites existing value)
                            req.body[field] = uploadedIds[0];
                        } else {
                            // Multiple file field: merge existing IDs with new IDs (from upload)
                            const existingArray = Array.isArray(existingIds) ? existingIds : (existingIds ? [existingIds] : []);
                            req.body[field] = [...existingArray, ...uploadedIds];
                        }
                    } else {
                        // No files uploaded for this field
                        if (existingIds !== undefined) {
                            // Keep the existing value (ObjectId string or array of ObjectIds)
                            req.body[field] = existingIds;
                        } else {
                            // No files and no existing value - set default based on field type
                            const fieldMaxCount = fields[field];
                            req.body[field] = fieldMaxCount === 1 ? undefined : [];
                        }
                    }
                });
                logger.finish(`Successfully processed files by field: ${Object.entries(fileIdsByField).map(([field, ids]) => `${field}(${ids.length})`).join(', ')}`);
            } else {
                // Single field mode: attach flat array for backward compatibility
                req.body.fileIds = fileIds;
                logger.finish(`Successfully processed ${fileIds.length} file(s). File IDs: ${fileIds.join(', ')}`);
            }

            // If the route fails without a transaction, asyncHandler hands these to the orphan cleanup (TD-B249).
            req.body._mediaUploadMediaIds = storedUploads.map(upload => upload.mediaId.toString());

            next();

        } catch (error: any) {
            logger.err("Error in unified media upload middleware:", error);

            // When using a transaction: abort and clean up orphaned GridFS files
            // (Media docs roll back via transaction; GridFS does not, so we delete explicitly)
            if (session?.inTransaction?.()) {
                try {
                    const gridFsIds = req.body?._mediaUploadGridFsIds as string[] | undefined;
                    if (gridFsIds?.length) {
                        const gridfsForCleanup = getGridFSStorage(languageCode, 'media', logger);
                        for (const id of gridFsIds) {
                            try {
                                await gridfsForCleanup.deleteFile(id);
                            } catch (delErr: any) {
                                logger.warn(`Failed to clean up GridFS file ${id} on rollback: ${delErr.message}`);
                            }
                        }
                    }
                    await session.abortTransaction();
                } catch (abortErr: any) {
                    logger.err("Error aborting transaction in media upload middleware:", abortErr);
                }
                try {
                    await session.endSession();
                } catch (endErr: any) {
                    logger.err("Error ending session in media upload middleware:", endErr);
                }
            }
            else {
                await discardStoredUploads(storedUploads, languageCode, logger);
            }

            next(error);
        }
    };
}


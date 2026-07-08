import {NextFunction} from 'express';
import multer, {FileFilterCallback} from 'multer';
import {ClientSession, Types as MongooseTypes} from 'mongoose';
import {getLogger, serverLogger} from '@coreModule/loggers/serverLog';
import {mediaService} from '@coreModule/database/schemas/media/media.service';
import {IMedia, IMediaMetadata} from '@coreModule/database/schemas/media/media';
import {apiValidationException} from 'armonia/src/modules/core/helpers/exceptions';
import {getGridFSStorage} from '@coreModule/utilities/gridfs/gridfsStorage';
import {FileScannerFactory} from '@coreModule/utilities/security/fileScanner';
import {Readable} from 'stream';
import path from 'path';
import {
    ALLOWED_MIME_TYPES,
    BLOCKED_EXTENSIONS,
    BLOCKED_MIME_TYPES,
    FILE_SIGNATURES
} from "armonia/src/modules/core/constants";
import {FILE_UPLOAD} from "@coreModule/environment";

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
    /** Whether to sanitize PDFs by removing JavaScript and embedded objects (requires pdf-lib, default: false) */
    sanitizePdfs?: boolean;
    /** Whether to validate Office documents structure (default: true) */
    validateOfficeDocuments?: boolean;
    /** Whether to block Office documents with embedded macros or objects (default: true) */
    blockDangerousOfficeContent?: boolean;
    /** Whether to extract image resolution (requires sharp package, default: false) */
    extractImageResolution?: boolean;
    /** Whether to extract video/audio duration (requires ffmpeg, default: false) */
    extractMediaDuration?: boolean;
}

/**
 * Gets file extension from filename
 */
function getFileExtension(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    return ext || '';
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
 * Validates file type and extension
 */
function validateFileType(mimeType: string, filename: string, languageCode: string): void {
    const extension = getFileExtension(filename);

    // Check blocked extensions
    if (BLOCKED_EXTENSIONS.includes(extension)) {
        throw apiValidationException(
            "file_type_blocked",
            null,
            null,
            languageCode
        );
    }

    // Check blocked MIME types
    if (BLOCKED_MIME_TYPES.includes(mimeType)) {
        throw apiValidationException(
            "file_type_blocked",
            null,
            null,
            languageCode
        );
    }

    // Check allowed MIME types
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
        throw apiValidationException(
            "file_type_not_allowed",
            null,
            null,
            languageCode
        );
    }
}

/**
 * Validates file content against MIME type using magic bytes
 */
function validateFileContentBySignature(buffer: Buffer, expectedMimeType: string): boolean {
    try {
        const signatures = FILE_SIGNATURES[expectedMimeType];
        if (!signatures || signatures.length === 0) {
            console.log(`[validate] No signatures for MIME type: ${expectedMimeType}`);
            return true;
        }

        if (buffer.length === 0) {
            console.log(`[validate] Buffer is empty`);
            return false;
        }

        // Check if file matches any of the expected signatures
        return signatures.some(signature => {
            // console.log(`[validate] Checking signature for ${expectedMimeType}:`, signature);
            // console.log(`[validate] Buffer first ${signature.length} bytes:`, Array.from(buffer.slice(0, signature.length)));

            if (buffer.length < signature.length) {
                // console.log(`[validate] Buffer shorter than signature`);
                return false;
            }

            const match = signature.every((byte, index) => buffer[index] === byte);
            // console.log(`[validate] Signature match result:`, match);
            return match;
        });
    } catch (error) {
        console.log(`[validate] Error validating file:`, error);
        return false;
    }
}

/**
 * Sanitizes image by re-encoding it, which strips all metadata and embedded scripts
 * Works with buffer instead of file path
 */
async function sanitizeImageBuffer(inputBuffer: Buffer, mimeType: string): Promise<{buffer: Buffer; resolution?: {width: number; height: number}}> {

    try {
        const sharp = require('sharp');
        let pipeline = sharp(inputBuffer);

        // Determine output format based on MIME type
        if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
            pipeline = pipeline.jpeg({ quality: 90, mozjpeg: true });
        }
        else if (mimeType === 'image/png') {
            pipeline = pipeline.png({ quality: 90, compressionLevel: 9 });
        }
        else if (mimeType === 'image/webp') {
            pipeline = pipeline.webp({ quality: 90 });
        }
        else if (mimeType === 'image/gif') {
            // GIFs are tricky - convert to PNG for safety
            pipeline = pipeline.png({ quality: 90 });
        }
        else {
            // For other image types, convert to JPEG as safe default
            pipeline = pipeline.jpeg({ quality: 90, mozjpeg: true });
        }

        // Re-encode image - this strips ALL metadata, EXIF data, and embedded scripts
        const sanitizedBuffer = await pipeline.toBuffer();

        // Get resolution
        const metadata = await sharp(sanitizedBuffer).metadata();
        const resolution = metadata.width && metadata.height ? {
            width: metadata.width,
            height: metadata.height
        } : undefined;

        return {
            buffer: sanitizedBuffer,
            resolution
        };
    } catch (error) {
        throw new Error(`Failed to sanitize image: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Sanitizes PDF by removing JavaScript, embedded files, and dangerous actions
 * Works with buffer instead of file path
 */
async function sanitizePdfBuffer(inputBuffer: Buffer): Promise<Buffer> {

    try {
        const {PDFDocument} = require('pdf-lib');

        // Load the PDF
        const pdfDoc = await PDFDocument.load(inputBuffer);

        // Create a new clean PDF
        const cleanPdf = await PDFDocument.create();
        
        // Copy pages without JavaScript
        const pages = pdfDoc.getPages();
        for (let i = 0; i < pages.length; i++) {
            const [copiedPage] = await cleanPdf.copyPages(pdfDoc, [i]);
            cleanPdf.addPage(copiedPage);
        }

        // Save the sanitized PDF
        const sanitizedBytes = await cleanPdf.save();
        return Buffer.from(sanitizedBytes);

    } catch (error) {
        throw new Error(`Failed to sanitize PDF: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Validates Office document structure (DOCX, XLSX, PPTX are ZIP files)
 * Works with buffer instead of file path
 */
async function validateOfficeDocumentBuffer(buffer: Buffer, mimeType: string): Promise<{isValid: boolean; warnings: string[]}> {
    const warnings: string[] = [];

    try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries();

        // Check for dangerous embedded objects
        const dangerousPatterns = [
            /\.vba$/i,           // VBA macros
            /\.bin$/i,           // Binary embedded objects
            /activeX/i,          // ActiveX controls
            /\.ocx$/i,           // OCX files
            /\.dll$/i,           // DLL files
            /\.exe$/i,           // Executable files
            /\.js$/i,            // JavaScript files
            /\.vbs$/i,           // VBScript files
            /\.wsf$/i,           // Windows Script files
        ];

        for (const entry of entries) {
            const entryName = entry.entryName.toLowerCase();
            
            // Check for dangerous patterns
            for (const pattern of dangerousPatterns) {
                if (pattern.test(entryName)) {
                    warnings.push(`Potentially dangerous content detected: ${entryName}`);
                }
            }

            // Check for embedded OLE objects (can contain executables)
            if (entryName.includes('oleObject') || entryName.includes('embeddings')) {
                warnings.push(`Embedded object detected: ${entryName}`);
            }
        }

        return {
            isValid: warnings.length === 0,
            warnings
        };

    } catch (error) {
        return {
            isValid: false,
            warnings: [`Failed to validate Office document structure: ${error instanceof Error ? error.message : String(error)}`]
        };
    }
}

/**
 * Extracts image resolution from buffer (optional - requires sharp package)
 */
async function getImageResolutionFromBuffer(buffer: Buffer): Promise<{width: number; height: number} | undefined> {

    try {
        const sharp = require('sharp');
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

/**
 * Unified Media Upload Middleware
 * 
 * Handles all file uploads using multer (memory storage), validates files,
 * scans for security threats, sanitizes content, and stores in GridFS.
 * This is the single, unified middleware for all media uploads in the application.
 * 
 * **Security Features:**
 * - **File Type Validation**: Blocks dangerous extensions and MIME types
 * - **File Content Validation**: Validates actual file content against MIME type using magic bytes
 * - **Security Scanning**: Pluggable scanner (ClamAV/VirusTotal/Mock)
 * - **Image Sanitization**: Re-encodes images to strip metadata and embedded scripts (requires sharp)
 * - **PDF Sanitization**: Removes JavaScript and embedded objects from PDFs (requires pdf-lib)
 * - **Office Document Validation**: Validates structure and blocks dangerous embedded content (requires adm-zip)
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
        maxFiles = FILE_UPLOAD.MAX_FILES_UPLOADED,
        maxFileSize = FILE_UPLOAD.MAX_FILE_SIZE,
        enableSecurityScan = true,
        validateFileContent = true,
        sanitizeImages = true,
        sanitizePdfs = true,
        validateOfficeDocuments = true,
        blockDangerousOfficeContent = true,
        extractImageResolution = true,
        extractMediaDuration = true
    } = options;

    // Configure multer with memory storage (we'll stream to GridFS)
    const storage = multer.memoryStorage();

    // Configure file filter
    const fileFilter = (req: any, file: Express.Multer.File, cb: FileFilterCallback) => {
        const languageCode = req.header("language") || "en-US";
        
        try {
            // Never trust client MIME type - validate it
            validateFileType(file.mimetype, file.originalname, languageCode);
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

        try {
            logger.start("Processing unified media upload...");

            // Preserve existing req.body data before multer processes the request
            // Multer will overwrite req.body with form fields, so we need to merge it back
            const existingBody = { ...req.body };
            let files: Express.Multer.File[] = [];
            let filesByField: Record<string, Express.Multer.File[]> = {};

            try{
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

                // Wrap multer in a promise
                await new Promise<void>((resolve, reject) => {
                    multerMiddleware(req, res, (err: any) => {
                        if (err) {
                            if (err.code === 'LIMIT_FILE_SIZE') {
                                return reject(apiValidationException("file_too_large", null, null, languageCode));
                            }
                            if (err.code === 'LIMIT_FILE_COUNT') {
                                return reject(apiValidationException("too_many_files", null, null, languageCode));
                            }
                            return reject(err);
                        }
                        resolve();
                    });
                });
            }
            catch (e){
                // Preserve existing files if multer fails
                if (req.files) {
                    if (Array.isArray(req.files)) {
                        files = req.files;
                    } else if (typeof req.files === 'object') {
                        filesByField = req.files as Record<string, Express.Multer.File[]>;
                    }
                }
            }

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

            req.body = {
                ...existingBody,
                ...req.body,
                ...jsonData
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
                    const extension = getFileExtension(file.originalname);
                    const fileBuffer = file.buffer;

                    logger.debug(`Processing file: ${file.originalname} (${file.mimetype}, ${file.size} bytes)`);

                    // Security: Validate file content against MIME type using magic bytes
                    if (validateFileContent) {
                        const isValid = validateFileContentBySignature(fileBuffer, file.mimetype);
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
                            processedBuffer = await sanitizePdfBuffer(processedBuffer);
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

                    // SECURITY: Validate Office documents structure
                    if (validateOfficeDocuments && (fileType === 'document' || file.mimetype.includes('office') || file.mimetype.includes('msword') || file.mimetype.includes('spreadsheet') || file.mimetype.includes('presentation'))) {
                        try {
                            const validation = await validateOfficeDocumentBuffer(processedBuffer, file.mimetype);

                            if (!validation.isValid || (blockDangerousOfficeContent && validation.warnings.length > 0)) {
                                logger.warn(`Office document validation failed for ${file.originalname}:`, validation.warnings);
                                throw apiValidationException(
                                    "office_document_validation_failed",
                                    null,
                                    null,
                                    languageCode
                                );
                            }

                            if (validation.warnings.length > 0) {
                                logger.warn(`Office document warnings for ${file.originalname}:`, validation.warnings);
                            }
                        }
                        catch (validationError: any) {
                            if (validationError.error_code) {
                                throw validationError;
                            }
                            logger.err(`Error validating Office document ${file.originalname}:`, validationError);
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

                    // Upload processed file to GridFS
                    const fileStream = Readable.from(processedBuffer);
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
                        type: fileType,
                        originalName: file.originalname,
                        fileName: file.originalname, // Keep original name for display
                        fileId: mongooseFileId as any, // Type assertion needed due to MongoDB vs Mongoose ObjectId types
                        createdBy: userId as any, // Type assertion for Mongoose ObjectId (ownershipPlugin)
                        ...(req.body?.user?.company && { company: req.body?.user?.company?._id as any }),
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

            next(error);
        }
    };
}


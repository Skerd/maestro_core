/**
 * GridFS Storage Utility
 * 
 * Handles file storage and retrieval using MongoDB GridFS.
 * GridFS is ideal for storing files larger than 16MB and provides
 * efficient streaming for file operations.
 */

import {GridFSBucket, ObjectId} from 'mongodb';
import {mongooseInstance} from '@coreModule/connections/connectToMongoDb';
import {getLogger, serverLogger} from '@coreModule/loggers/serverLog';
import {Readable} from 'stream';
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {FILE_UPLOAD} from "@coreModule/environment";

export class GridFSStorage {
    private bucket: GridFSBucket;
    private logger: serverLogger;
    private languageCode: string = "en-US";
    private maxFileSize: number;

    constructor(languageCode: string, bucketName: string = 'media', logger?: serverLogger, maxFileSize?: number) {
        this.logger = logger || getLogger('gridfs_storage');
        this.languageCode = languageCode;
        this.maxFileSize = maxFileSize || FILE_UPLOAD.MAX_FILE_SIZE || 100 * 1024 * 1024; // Default 100MB
        const db = mongooseInstance.connection.db;
        if (!db) {
            throw new Error('MongoDB connection not established. Cannot create GridFS bucket.');
        }
        this.bucket = new GridFSBucket(db, { bucketName });
    }

    /**
     * Upload a file to GridFS
     * 
     * @param fileStream - Readable stream of file data
     * @param filename - Original filename
     * @param metadata - Optional metadata to store with the file
     * @returns Promise resolving to the GridFS file ID
     */
    async uploadFile(
        fileStream: Readable | Buffer,
        filename: string,
        metadata?: Record<string, any>
    ): Promise<ObjectId> {
        return new Promise((resolve, reject) => {
            try {
                // Validate file size for Buffer
                if (Buffer.isBuffer(fileStream)) {
                    if (fileStream.length > this.maxFileSize) {
                        const maxSizeMB = (this.maxFileSize / (1024 * 1024)).toFixed(2);
                        const fileSizeMB = (fileStream.length / (1024 * 1024)).toFixed(2);
                        this.logger.warn(`File size ${fileSizeMB}MB exceeds maximum ${maxSizeMB}MB`);
                        reject(apiValidationException(
                            "file_size_exceeds_limit",
                            null,
                            null,
                            // { maxSize: this.maxFileSize, fileSize: fileStream.length },
                            this.languageCode
                        ));
                        return;
                    }
                }

                const uploadStream = this.bucket.openUploadStream(filename, {
                    metadata: metadata || {}
                });

                let totalBytes = 0;

                // Track file size for streams
                if (!Buffer.isBuffer(fileStream)) {
                    fileStream.on('data', (chunk: Buffer) => {
                        totalBytes += chunk.length;
                        if (totalBytes > this.maxFileSize) {
                            fileStream.destroy();
                            uploadStream.destroy();
                            const maxSizeMB = (this.maxFileSize / (1024 * 1024)).toFixed(2);
                            reject(apiValidationException(
                                "file_size_exceeds_limit",
                                null,
                                null,
                                // { maxSize: this.maxFileSize, fileSize: totalBytes },
                                this.languageCode
                            ));
                        }
                    });
                }

                // Handle stream or buffer
                if (Buffer.isBuffer(fileStream)) {
                    const bufferStream = new Readable();
                    bufferStream.push(fileStream);
                    bufferStream.push(null);
                    bufferStream.pipe(uploadStream);
                } else {
                    fileStream.pipe(uploadStream);
                }

                uploadStream.on('finish', () => {
                    this.logger.debug(`File uploaded to GridFS: ${filename} (ID: ${uploadStream.id}, Size: ${totalBytes || (fileStream as Buffer).length} bytes)`);
                    resolve(uploadStream.id);
                });

                uploadStream.on('error', (error) => {
                    this.logger.err(`Error uploading file to GridFS: ${error.message}`);
                    reject(error);
                });
            } catch (error: any) {
                this.logger.err(`Failed to upload file to GridFS: ${error.message}`);
                reject(apiValidationException("failed_to_save_file", null, null, this.languageCode));
            }
        });
    }

    /**
     * Download a file from GridFS
     * 
     * @param fileId - GridFS file ID
     * @returns Readable stream of file data
     */
    downloadFile(fileId: ObjectId | string): Readable {
        const id = typeof fileId === 'string' ? new ObjectId(fileId) : fileId;
        return this.bucket.openDownloadStream(id);
    }

    /**
     * Get file metadata from GridFS
     * 
     * @param fileId - GridFS file ID
     * @returns Promise resolving to file metadata
     */
    async getFileMetadata(fileId: ObjectId | string): Promise<any> {
        const id = typeof fileId === 'string' ? new ObjectId(fileId) : fileId;
        const files = await this.bucket.find({ _id: id }).toArray();
        
        if (files.length === 0) {
            throw new Error(`File not found in GridFS: ${fileId}`);
        }

        return files[0];
    }

    /**
     * Delete a file from GridFS
     * 
     * @param fileId - GridFS file ID
     * @returns Promise resolving when deletion is complete
     */
    async deleteFile(fileId: ObjectId | string): Promise<void> {
        const id = typeof fileId === 'string' ? new ObjectId(fileId) : fileId;
        return new Promise((resolve, reject) => {
            this.bucket.delete(id, (error) => {
                if (error) {
                    this.logger.err(`Error deleting file from GridFS: ${error.message}`);
                    reject(apiValidationException("failed_to_delete_file", null, null, this.languageCode));
                } else {
                    this.logger.debug(`File deleted from GridFS: ${fileId}`);
                    resolve();
                }
            });
        });
    }

    /**
     * Check if a file exists in GridFS
     * 
     * @param fileId - GridFS file ID
     * @returns Promise resolving to boolean indicating existence
     */
    async fileExists(fileId: ObjectId | string): Promise<boolean> {
        try {
            const id = typeof fileId === 'string' ? new ObjectId(fileId) : fileId;
            const files = await this.bucket.find({ _id: id }).limit(1).toArray();
            return files.length > 0;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get file stream as buffer (for processing)
     * 
     * @param fileId - GridFS file ID
     * @returns Promise resolving to file buffer
     */
    async getFileBuffer(fileId: ObjectId | string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            const downloadStream = this.downloadFile(fileId);

            downloadStream.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
            });

            downloadStream.on('end', () => {
                resolve(Buffer.concat(chunks));
            });

            downloadStream.on('error', (error) => {
                reject(error);
            });
        });
    }
}

// Export factory function (removed singleton to allow multiple buckets)
export function createGridFSStorage(
    languageCode: string,
    bucketName: string = 'media',
    logger?: serverLogger,
    maxFileSize?: number
): GridFSStorage {
    return new GridFSStorage(languageCode, bucketName, logger, maxFileSize);
}

// Legacy singleton export for backward compatibility
let gridfsStorageInstance: GridFSStorage | null = null;

export function getGridFSStorage(languageCode: string, bucketName?: string, logger?: serverLogger): GridFSStorage {
    if (!gridfsStorageInstance) {
        gridfsStorageInstance = new GridFSStorage(languageCode, bucketName, logger);
    }
    return gridfsStorageInstance;
}


/**
 * Base CRUD Service
 * 
 * Provides standardized CRUD operations for all database models.
 * Supports transactions, timing, and consistent error handling.
 */

import {ClientSession, Document, FilterQuery, Model, QueryOptions, UpdateQuery} from 'mongoose';
import {ObjectId} from 'mongodb';
import {performance} from 'perf_hooks';
import {serverLogger} from '@coreModule/loggers/serverLog';
import {timeFunction} from '@coreModule/utilities/timing/functionTimer';
import {apiValidationException} from 'armonia/src/modules/core/helpers/exceptions';
import {CONSTANTS} from "@coreModule/environment";
import {ActionException} from "armonia/src/modules/core/types";

/**
 * CRUD options
 */
export interface CrudOptions {
    /** MongoDB session for transactions */
    session?: ClientSession;
    /** Logger instance */
    logger?: serverLogger;
    /** Language code for error messages */
    languageCode?: string;
    /** Whether to time operations */
    timeOperations?: boolean;
    /** User ID for audit logging */
    auditUserId?: string | ObjectId;
    /** For models with softDeletePlugin: force physical delete instead of soft delete */
    hard?: boolean;
    /** For models with softDeletePlugin: include soft-deleted documents in find queries */
    withDeleted?: boolean;
}

/**
 * Pagination options
 */
export interface PaginationOptions {
    page?: number;
    limit?: number;
    sort?: Record<string, 1 | -1>;
}

/**
 * Paginated result
 */
export interface PaginatedResult<T> {
    data: T[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
}

function lowerFirst(str: string): string {
    if (!str) return str;
    return str.charAt(0).toLowerCase() + str.slice(1);
}

/**
 * Base CRUD Service Class
 * 
 * Provides standard CRUD operations that work with any Mongoose model.
 * 
 * @template T - The document type
 * @template TModel - The Mongoose model type
 */
export class BaseCrudService<T extends Document, TModel extends Model<T>> {
    protected model: TModel;
    protected modelName: string;
    protected defaultLanguageCode: string = CONSTANTS.DEFAULT_LANGUAGE;
    /** Slow query threshold in milliseconds (default: 100ms) */
    protected slowQueryThreshold: number = parseInt(process.env.MONGODB_SLOW_QUERY_THRESHOLD || '100', 10);

    constructor(model: TModel, modelName: string) {
        if (!model) {
            throw new Error(
                `BaseCrudService: Model is undefined for "${modelName}". ` +
                `This usually indicates a circular dependency or the model not being properly exported. ` +
                `Make sure the model is imported correctly and fully initialized.`
            );
        }
        this.model = model;
        this.modelName = modelName;
    }

    /**
     * Log slow query if duration exceeds threshold
     * 
     * @param operation - Operation name
     * @param duration - Duration in milliseconds
     * @param query - Query details
     * @param logger - Optional logger
     */
    protected logSlowQuery(
        operation: string,
        duration: number,
        query: any,
        logger?: serverLogger
    ): void {
        if (duration > this.slowQueryThreshold && logger) {
            logger.warn?.(
                `Slow query detected: ${this.modelName}.${operation} took ${duration.toFixed(2)}ms (threshold: ${this.slowQueryThreshold}ms)`,
                {
                    model: this.modelName,
                    operation,
                    duration,
                    threshold: this.slowQueryThreshold,
                    query: JSON.stringify(query, null, 2)
                }
            );
        }
    }

    /**
     * Create a new document
     * 
     * @param data - Data to create
     * @param options - CRUD options
     * @returns Created document
     * 
     * @example
     * ```typescript
     * const company = await companyService.create({
     *     name: 'New Company',
     *     email: 'company@example.com'
     * }, { session, logger });
     * ```
     */
    async create(
        data: Partial<T>,
        options: CrudOptions = {}
    ): Promise<T> {
        const { session, logger, languageCode, timeOperations = true, auditUserId } = options;

        const operation = async () => {
            try {
                const createData = { ...data } as Partial<T> & { createdBy?: ObjectId };
                if (auditUserId && !('createdBy' in createData && createData.createdBy != null)) {
                    createData.createdBy = typeof auditUserId === 'string' ? new ObjectId(auditUserId) : auditUserId;
                }
                const doc = new this.model(createData);
                // Set auditUserId for audit logging if provided
                if (auditUserId) {
                    doc.$locals = doc.$locals || {};
                    doc.$locals.auditUserId = typeof auditUserId === 'string' ? new ObjectId(auditUserId) : auditUserId;
                }
                return await doc.save({session});
            } catch (error: any) {
                if (error.code === 11000) {
                    // Duplicate key error
                    throw apiValidationException(
                        `${lowerFirst(this.modelName)}_already_exists`,
                        null,
                        null,
                        languageCode || this.defaultLanguageCode
                    );
                }
                throw error;
            }
        };

        if (timeOperations && logger) {
            const { result, timing } = await timeFunction(
                operation,
                `${this.modelName}.create`,
                { logger, logLevel: 'debug' }
            );
            this.logSlowQuery('create', timing.duration, { data }, logger);
            return result;
        }

        const startTime = performance.now();
        const result = await operation();
        const duration = performance.now() - startTime;
        this.logSlowQuery('create', duration, { data }, logger);
        return result;
    }

    /**
     * Create multiple documents
     * 
     * @param dataArray - Array of data to create
     * @param options - CRUD options
     * @returns Array of created documents
     */
    async createMany(
        dataArray: Partial<T>[],
        options: CrudOptions = {}
    ): Promise<T[]> {
        const { session, logger, timeOperations = true, auditUserId } = options;

        const operation = async () => {
            const objectIdActionUserId = auditUserId
                ? (typeof auditUserId === 'string' ? new ObjectId(auditUserId) : auditUserId)
                : null;
            const createDataArray = dataArray.map((item) => {
                const createData = { ...item } as Partial<T> & { createdBy?: ObjectId };
                if (objectIdActionUserId && !('createdBy' in createData && createData.createdBy != null)) {
                    createData.createdBy = objectIdActionUserId;
                }
                return createData;
            });
            return await this.model.create(createDataArray, { session });
        };

        if (timeOperations && logger) {
            const { result } = await timeFunction(
                operation,
                `${this.modelName}.createMany`,
                { logger, logLevel: 'debug' }
            );
            return result;
        }

        return await operation();
    }

    /**
     * Find a document by ID
     * 
     * @param id - Document ID
     * @param options - CRUD options
     * @param populate - Fields to populate
     * @param select - Fields to select (e.g., 'name surname' or ['name', 'surname'])
     * @returns Document or null
     * 
     * @example
     * ```typescript
     * const company = await companyService.findById(id, { session, logger });
     * if (!company) throw new Error('Not found');
     * 
     * // Select specific fields
     * const user = await userService.findById(id, { session, logger }, undefined, 'name surname');
     * ```
     */
    async findById(
        id: string | ObjectId,
        options: CrudOptions = {},
        populate?: string | string[] | any,
        select?: string | string[]
    ): Promise<T | null> {
        const { session, logger, timeOperations = true } = options;

        const operation = async () => {
            let query: any = this.model.findById(id);
            if (options.withDeleted === true && typeof query.withDeleted === 'function') {
                query = query.withDeleted();
            } else if (options.withDeleted === false && typeof query.noDeleted === 'function') {
                query = query.noDeleted();
            }
            if (session) {
                query = query.session(session);
            }
            
            if (select) {
                query = query.select(select);
            }
            
            if (populate) {
                if (Array.isArray(populate)) {
                    populate.forEach((path: any) => {
                        query = query.populate(path);
                    });
                } else {
                    query = query.populate(populate);
                }
            }
            
            return await query.exec() as T | null;
        };

        if (timeOperations && logger) {
            const { result, timing } = await timeFunction(
                operation,
                `${this.modelName}.findById`,
                { logger, logLevel: 'debug' }
            );
            this.logSlowQuery('findById', timing.duration, { id }, logger);
            return result;
        }

        const startTime = performance.now();
        const result = await operation();
        const duration = performance.now() - startTime;
        this.logSlowQuery('findById', duration, { id }, logger);
        return result;
    }

    /**
     * Find a document by ID or throw error
     * 
     * @param id - Document ID
     * @param options - CRUD options
     * @param populate - Fields to populate (string, string[], or complex populate objects)
     * @param select - Fields to select (e.g., 'name surname' or ['name', 'surname'])
     * @returns Document (never null)
     * @throws Error if not found
     * 
     * @example
     * ```typescript
     * // Select specific fields
     * const user = await userService.findByIdOrThrow(id, { session, logger }, undefined, 'name surname');
     * 
     * // Complex populate
     * const company = await companyService.findByIdOrThrow(id, { logger, languageCode }, [
     *     { path: "addresses", populate: [{ path: "city", select: "name" }] }
     * ]);
     * ```
     */
    async findByIdOrThrow(
        id: string | ObjectId,
        options: CrudOptions = {},
        populate?: string | string[] | any,
        select?: string | string[]
    ): Promise<T> {
        const { languageCode } = options;
        const doc = await this.findById(id, options, populate, select);
        
        if (!doc) {
            throw apiValidationException(
                `${lowerFirst(this.modelName)}_not_found`,
                null,
                null,
                languageCode || this.defaultLanguageCode
            );
        }
        
        return doc;
    }

    /**
     * Find one document by query
     * 
     * @param query - MongoDB query
     * @param options - CRUD options
     * @param populate - Fields to populate
     * @param select - Fields to select (e.g., 'name surname' or ['name', 'surname'])
     * @returns Document or null
     */
    async findOne(
        query: FilterQuery<T>,
        options: CrudOptions = {},
        populate?: string | string[] | any,
        select?: string | string[]
    ): Promise<T | null> {
        const { session, logger, timeOperations = true } = options;

        const operation = async () => {
            let mongooseQuery: any = this.model.findOne(query);
            if (options.withDeleted === true && typeof mongooseQuery.withDeleted === 'function') {
                mongooseQuery = mongooseQuery.withDeleted();
            } else if (options.withDeleted === false && typeof mongooseQuery.noDeleted === 'function') {
                mongooseQuery = mongooseQuery.noDeleted();
            }
            if (session) {
                mongooseQuery = mongooseQuery.session(session);
            }
            
            if (select) {
                mongooseQuery = mongooseQuery.select(select);
            }
            
            if (populate) {
                if (Array.isArray(populate)) {
                    populate.forEach((path: any) => {
                        mongooseQuery = mongooseQuery.populate(path);
                    });
                } else {
                    mongooseQuery = mongooseQuery.populate(populate);
                }
            }
            
            return await mongooseQuery.exec() as T | null;
        };

        if (timeOperations && logger) {
            const { result, timing } = await timeFunction(
                operation,
                `${this.modelName}.findOne`,
                { logger, logLevel: 'debug' }
            );
            this.logSlowQuery('findOne', timing.duration, { query }, logger);
            return result;
        }

        const startTime = performance.now();
        const result = await operation();
        const duration = performance.now() - startTime;
        this.logSlowQuery('findOne', duration, { query }, logger);
        return result;
    }

    /**
     * Find one document by query or throw error
     *
     * @param query - MongoDB query
     * @param options - CRUD options
     * @param populate - Fields to populate
     * @param select - Fields to select (e.g., 'name surname' or ['name', 'surname'])
     * @param customError
     * @returns Document (never null)
     * @throws Error if not found
     */
    async findOneOrThrow(
        query: FilterQuery<T>,
        options: CrudOptions = {},
        populate?: string | string[] | any,
        select?: string | string[],
        customError?: ActionException
    ): Promise<T> {
        const { languageCode } = options;
        const doc = await this.findOne(query, options, populate, select);

        if (!doc) {
            if( !!customError ) {
                throw customError;
            }
            throw apiValidationException(
                `${lowerFirst(this.modelName)}_not_found`,
                null,
                null,
                languageCode || this.defaultLanguageCode
            );
        }

        return doc;
    }

    /**
     * Find multiple documents
     * 
     * @param query - MongoDB query
     * @param options - CRUD options
     * @param populate - Fields to populate
     * @param select - Fields to select (e.g., 'name surname' or ['name', 'surname'])
     * @param sort - Sort criteria (e.g., 'name', '-name', { name: 1, age: -1 }, or [['name', 1]])
     * @param limit - Maximum number of documents to return
     * @param offset - Number of documents to skip (for pagination)
     * @returns Array of documents
     */
    async find(
        query: FilterQuery<T> = {},
        options: CrudOptions = {},
        populate?: string | string[] | any,
        select?: string | string[],
        sort?: string | Record<string, 1 | -1> | [string, 1 | -1][],
        limit?: number,
        offset?: number
    ): Promise<T[]> {
        const { session, logger, timeOperations = true } = options;

        const operation = async () => {
            let mongooseQuery: any = this.model.find(query);
            if (options.withDeleted === true && typeof mongooseQuery.withDeleted === 'function') {
                mongooseQuery = mongooseQuery.withDeleted();
            } else if (options.withDeleted === false && typeof mongooseQuery.noDeleted === 'function') {
                mongooseQuery = mongooseQuery.noDeleted();
            }
            if (session) {
                mongooseQuery = mongooseQuery.session(session);
            }
            
            if (select) {
                mongooseQuery = mongooseQuery.select(select);
            }

            if (sort) {
                mongooseQuery = mongooseQuery.sort(sort);
            }
            
            if (offset !== undefined && offset > 0) {
                mongooseQuery = mongooseQuery.skip(offset);
            }
            
            if (limit !== undefined && limit > 0) {
                mongooseQuery = mongooseQuery.limit(limit);
            }

            if (populate) {
                if (Array.isArray(populate)) {
                    populate.forEach((path: any) => {
                        mongooseQuery = mongooseQuery.populate(path);
                    });
                } else {
                    mongooseQuery = mongooseQuery.populate(populate);
                }
            }
            
            return await mongooseQuery.exec() as T[];
        };

        if (timeOperations && logger) {
            const { result, timing } = await timeFunction(
                operation,
                `${this.modelName}.find`,
                { logger, logLevel: 'debug' }
            );
            this.logSlowQuery('find', timing.duration, { query, limit, offset }, logger);
            return result;
        }

        const startTime = performance.now();
        const result = await operation();
        const duration = performance.now() - startTime;
        this.logSlowQuery('find', duration, { query, limit, offset }, logger);
        return result;
    }

    /**
     * Find documents with pagination
     * 
     * @param query - MongoDB query
     * @param pagination - Pagination options
     * @param options - CRUD options
     * @param populate - Fields to populate
     * @param select - Fields to select (e.g., 'name surname' or ['name', 'surname'])
     * @returns Paginated result
     */
    async findPaginated(
        query: FilterQuery<T> = {},
        pagination: PaginationOptions = {},
        options: CrudOptions = {},
        populate?: string | string[] | any,
        select?: string | string[]
    ): Promise<PaginatedResult<T>> {
        const { session, logger, timeOperations = true } = options;
        const { page = 1, limit = 10, sort } = pagination;
        const skip = (page - 1) * limit;

        const operation = async () => {
            // Get total count
            let countQuery: any = this.model.countDocuments(query);
            if (session) {
                countQuery = countQuery.session(session);
            }
            const total = await countQuery.exec();

            // Get data
            let dataQuery: any = this.model.find(query).skip(skip).limit(limit);
            if (session) {
                dataQuery = dataQuery.session(session);
            }
            
            if (select) {
                dataQuery = dataQuery.select(select);
            }
            
            if (sort) {
                dataQuery = dataQuery.sort(sort);
            }
            
            if (populate) {
                if (Array.isArray(populate)) {
                    populate.forEach((path: any) => {
                        dataQuery = dataQuery.populate(path);
                    });
                } else {
                    dataQuery = dataQuery.populate(populate);
                }
            }
            
            const data = await dataQuery.exec() as T[];
            const totalPages = Math.ceil(total / limit);

            return {
                data,
                total,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1
            };
        };

        if (timeOperations && logger) {
            const { result, timing } = await timeFunction(
                operation,
                `${this.modelName}.findPaginated`,
                { logger, logLevel: 'debug' }
            );
            this.logSlowQuery('findPaginated', timing.duration, { query, pagination }, logger);
            return result;
        }

        const startTime = performance.now();
        const result = await operation();
        const duration = performance.now() - startTime;
        this.logSlowQuery('findPaginated', duration, { query, pagination }, logger);
        return result;
    }

    /**
     * Update a document by ID
     * 
     * @param id - Document ID
     * @param update - Update data
     * @param options - CRUD options
     * @returns Updated document or null
     */
    async updateById(
        id: string | ObjectId,
        update: UpdateQuery<T>,
        options: CrudOptions & { returnNew?: boolean } & QueryOptions = {}
    ): Promise<T | null> {
        const { session, logger, returnNew = true, timeOperations = true, auditUserId } = options;

        const operation = async () => {
            // If auditUserId is provided, use find + save to trigger audit plugin
            // Otherwise use findByIdAndUpdate for better performance
            if (auditUserId) {
                const doc = await this.model.findById(id).session(session || null);
                if (!doc) {
                    return null;
                }
                // Check if update contains MongoDB operators (e.g., $set, $addToSet, $push)
                const hasOperators = Object.keys(update).some(key => key.startsWith('$'));
                if (hasOperators) {
                    // LIMITATION: MongoDB operators ($addToSet, $push, etc.) cannot be easily
                    // applied to document instances for audit logging. We use updateOne which
                    // bypasses Mongoose middleware (including audit plugin).
                    // For full audit support with operators, consider using direct field updates
                    // or manually creating audit log entries after the update.
                    if (logger) {
                        logger.warn?.(
                            `updateById with operators and auditUserId: Audit logging is limited for operator-based updates. ` +
                            `Consider using direct field updates for full audit support.`
                        );
                    }
                    // Use updateOne for operators (bypasses audit, but necessary for operators)
                    // Extract arrayFilters from options if present
                    const updateOptions: any = { session };
                    if ((options as any).arrayFilters) {
                        updateOptions.arrayFilters = (options as any).arrayFilters;
                    }
                    await this.model.updateOne({ _id: id }, update, updateOptions);
                    // Reload document to return updated state
                    const updatedDoc = await this.model.findById(id).session(session || null);
                    return returnNew ? updatedDoc : await this.model.findById(id).session(session || null);
                } else {
                    // Apply update to document directly (no operators) - full audit support
                    Object.assign(doc, update);
                    // Set auditUserId for audit logging
                    doc.$locals = doc.$locals || {};
                    doc.$locals.auditUserId = typeof auditUserId === 'string' ? new ObjectId(auditUserId) : auditUserId;
                    await doc.save({ session });
                    return returnNew ? doc : await this.model.findById(id).session(session || null);
                }
            } else {
                const queryOptions: QueryOptions = { new: returnNew, ...options };
                if (session) {
                    queryOptions.session = session;
                }
                return await this.model.findByIdAndUpdate(id, update, queryOptions).exec();
            }
        };

        if (timeOperations && logger) {
            const { result } = await timeFunction(
                operation,
                `${this.modelName}.updateById`,
                { logger, logLevel: 'debug' }
            );
            return result;
        }

        return await operation();
    }

    /**
     * Update a document by ID or throw error
     * 
     * @param id - Document ID
     * @param update - Update data
     * @param options - CRUD options
     * @returns Updated document
     * @throws Error if not found
     */
    async updateByIdOrThrow(
        id: string | ObjectId,
        update: UpdateQuery<T>,
        options: CrudOptions & { returnNew?: boolean } & QueryOptions = {}
    ): Promise<T> {
        const { languageCode } = options;
        const doc = await this.updateById(id, update, options);
        
        if (!doc) {
            throw apiValidationException(
                `${lowerFirst(this.modelName)}_not_found`,
                null,
                null,
                languageCode || this.defaultLanguageCode
            );
        }
        
        return doc;
    }

    /**
     * Update one document by query
     * 
     * @param query - MongoDB query
     * @param update - Update data
     * @param options - CRUD options
     * @returns Update result
     */
    async updateOne(
        query: FilterQuery<T>,
        update: UpdateQuery<T>,
        options: CrudOptions & QueryOptions= {}
    ): Promise<{ matchedCount: number; modifiedCount: number }> {
        const { session, logger, timeOperations = true } = options;

        const operation = async () => {
            const updateOptions: any = {};
            if (session) {
                updateOptions.session = session;
            }

            const result = await this.model.updateOne(query, update, updateOptions).exec();
            return {
                matchedCount: result.matchedCount,
                modifiedCount: result.modifiedCount
            };
        };

        if (timeOperations && logger) {
            const { result } = await timeFunction(
                operation,
                `${this.modelName}.updateOne`,
                { logger, logLevel: 'debug' }
            );
            return result;
        }

        return await operation();
    }

    /**
     * Update multiple documents
     * 
     * @param query - MongoDB query
     * @param update - Update data
     * @param options - CRUD options
     * @returns Update result
     */
    async updateMany(
        query: FilterQuery<T>,
        update: UpdateQuery<T>,
        options: CrudOptions & QueryOptions = {}
    ): Promise<{ matchedCount: number; modifiedCount: number }> {
        const { session, logger, timeOperations = true } = options;

        const operation = async () => {
            const updateOptions: any = {};
            if (session) {
                updateOptions.session = session;
            }

            const result = await this.model.updateMany(query, update, updateOptions).exec();
            return {
                matchedCount: result.matchedCount,
                modifiedCount: result.modifiedCount
            };
        };

        if (timeOperations && logger) {
            const { result } = await timeFunction(
                operation,
                `${this.modelName}.updateMany`,
                { logger, logLevel: 'debug' }
            );
            return result;
        }

        return await operation();
    }

    /**
     * Delete a document by ID
     * 
     * @param id - Document ID
     * @param options - CRUD options
     * @returns Deleted document or null
     */
    async deleteById(
        id: string | ObjectId,
        options: CrudOptions = {}
    ): Promise<T | null> {
        const { session, logger, timeOperations = true, auditUserId, hard } = options;

        const operation = async () => {
            const queryOptions: any = {};
            if (session) queryOptions.session = session;
            if (auditUserId !== undefined) queryOptions.auditUserId = auditUserId;
            if (hard) queryOptions.hard = hard;
            return await this.model.findByIdAndDelete(id, queryOptions).exec();
        };

        if (timeOperations && logger) {
            const { result } = await timeFunction(
                operation,
                `${this.modelName}.deleteById`,
                { logger, logLevel: 'debug' }
            );
            return result;
        }

        return await operation();
    }

    /**
     * Delete a document by ID or throw error
     * 
     * @param id - Document ID
     * @param options - CRUD options
     * @returns Deleted document
     * @throws Error if not found
     */
    async deleteByIdOrThrow(
        id: string | ObjectId,
        options: CrudOptions = {}
    ): Promise<T> {
        const { languageCode } = options;
        const doc = await this.deleteById(id, options);
        
        if (!doc) {
            throw apiValidationException(
                `${lowerFirst(this.modelName)}_not_found`,
                null,
                null,
                languageCode || this.defaultLanguageCode
            );
        }
        
        return doc;
    }

    /**
     * Restore a soft-deleted document by ID.
     * Uses find + instance restore + save so the audit plugin records the change.
     * Requires the model to use softDeletePlugin.
     *
     * @param id - Document ID
     * @param options - CRUD options (session, logger, languageCode, auditUserId)
     * @returns Restored document or null if not found
     * @throws Error if model does not have softDeletePlugin
     * @throws ActionException (error_code `not_deleted`) if the document exists but is not soft-deleted (no deletedAt)
     */
    async restoreById(
        id: string | ObjectId,
        options: CrudOptions = {}
    ): Promise<T | null> {
        const { session, logger, languageCode, timeOperations = true, auditUserId } = options;

        const operation = async () => {
            const doc = await this.findById(id, { session, withDeleted: true });
            if (!doc) return null;

            const docAny = doc as any;
            if (typeof docAny.restore !== 'function') {
                throw new Error(
                    `${this.modelName} does not support restore — softDeletePlugin is required.`
                );
            }

            if (!docAny.deletedAt) {
                throw apiValidationException(
                    'not_deleted',
                    null,
                    null,
                    languageCode || this.defaultLanguageCode
                );
            }

            if (auditUserId) {
                doc.$locals = doc.$locals || {};
                doc.$locals.auditUserId = typeof auditUserId === 'string' ? new ObjectId(auditUserId) : auditUserId;
            }

            await docAny.restore({ session });
            return doc;
        };

        if (timeOperations && logger) {
            const { result, timing } = await timeFunction(
                operation,
                `${this.modelName}.restoreById`,
                { logger, logLevel: 'debug' }
            );
            this.logSlowQuery('restoreById', timing.duration, { id }, logger);
            return result;
        }

        const startTime = performance.now();
        const result = await operation();
        const duration = performance.now() - startTime;
        this.logSlowQuery('restoreById', duration, { id }, logger);
        return result;
    }

    /**
     * Restore a soft-deleted document by ID or throw error.
     *
     * @param id - Document ID
     * @param options - CRUD options
     * @returns Restored document
     * @throws Error if model lacks softDeletePlugin
     * @throws ActionException if not found, `not_deleted`, or validation error
     */
    async restoreByIdOrThrow(
        id: string | ObjectId,
        options: CrudOptions = {}
    ): Promise<T> {
        const { languageCode } = options;
        const doc = await this.restoreById(id, options);

        if (!doc) {
            throw apiValidationException(
                `${lowerFirst(this.modelName)}_not_found`,
                null,
                null,
                languageCode || this.defaultLanguageCode
            );
        }

        return doc;
    }

    /**
     * Restore a soft-deleted document matching the query.
     * Uses find + instance restore + save so the audit plugin records the change.
     * Requires the model to use softDeletePlugin.
     *
     * @param query - Query to find the document (e.g. { _id, company })
     * @param options - CRUD options (session, logger, languageCode, auditUserId)
     * @returns Restored document or null if not found
     * @throws Error if model does not have softDeletePlugin
     * @throws ActionException (error_code `not_deleted`) if the document exists but is not soft-deleted (no deletedAt)
     */
    async restoreOne(
        query: FilterQuery<T>,
        options: CrudOptions = {}
    ): Promise<T | null> {
        const { session, logger, languageCode, timeOperations = true, auditUserId } = options;

        const operation = async () => {
            const doc = await this.findOne(query, { session, withDeleted: true });
            if (!doc) return null;

            const docAny = doc as any;
            if (typeof docAny.restore !== 'function') {
                throw new Error(
                    `${this.modelName} does not support restore — softDeletePlugin is required.`
                );
            }

            if (!docAny.deletedAt) {
                throw apiValidationException(
                    'not_deleted',
                    null,
                    null,
                    languageCode || this.defaultLanguageCode
                );
            }

            if (auditUserId) {
                doc.$locals = doc.$locals || {};
                doc.$locals.auditUserId = typeof auditUserId === 'string' ? new ObjectId(auditUserId) : auditUserId;
            }

            await docAny.restore({ session });
            return doc;
        };

        if (timeOperations && logger) {
            const { result, timing } = await timeFunction(
                operation,
                `${this.modelName}.restoreOne`,
                { logger, logLevel: 'debug' }
            );
            this.logSlowQuery('restoreOne', timing.duration, { query }, logger);
            return result;
        }

        const startTime = performance.now();
        const result = await operation();
        const duration = performance.now() - startTime;
        this.logSlowQuery('restoreOne', duration, { query }, logger);
        return result;
    }

    /**
     * Restore a soft-deleted document matching the query or throw error.
     *
     * @param query - Query to find the document
     * @param options - CRUD options
     * @returns Restored document
     * @throws Error if model lacks softDeletePlugin
     * @throws ActionException if not found, `not_deleted`, or validation error
     */
    async restoreOneOrThrow(
        query: FilterQuery<T>,
        options: CrudOptions = {}
    ): Promise<T> {
        const { languageCode } = options;
        const doc = await this.restoreOne(query, options);

        if (!doc) {
            throw apiValidationException(
                `${lowerFirst(this.modelName)}_not_found`,
                null,
                null,
                languageCode || this.defaultLanguageCode
            );
        }

        return doc;
    }

    /**
     * Delete one document by query
     * 
     * @param query - MongoDB query
     * @param options - CRUD options
     * @returns Delete result
     */
    async deleteOne(
        query: FilterQuery<T>,
        options: CrudOptions = {}
    ): Promise<{ deletedCount: number }> {
        const { session, logger, timeOperations = true } = options;

        const operation = async () => {
            const deleteOptions: any = {};
            if (session) deleteOptions.session = session;
            if (options.auditUserId !== undefined) deleteOptions.auditUserId = options.auditUserId;
            if (options.hard) deleteOptions.hard = options.hard;
            const result = await this.model.deleteOne(query, deleteOptions);
            return {
                deletedCount: result.deletedCount || 0
            };
        };

        if (timeOperations && logger) {
            const { result } = await timeFunction(
                operation,
                `${this.modelName}.deleteOne`,
                { logger, logLevel: 'debug' }
            );
            return result;
        }

        return await operation();
    }

    /**
     * Delete one document by query or throw error
     * 
     * @param query - MongoDB query
     * @param options - CRUD options
     * @returns Deleted document
     * @throws Error if not found
     */
    async deleteOneOrThrow(
        query: FilterQuery<T>,
        options: CrudOptions = {}
    ): Promise<T> {
        const { languageCode, session, logger, timeOperations = true, auditUserId, hard } = options;

        const operation = async () => {
            const deleteOptions: any = {};
            if (session) deleteOptions.session = session;
            if (auditUserId !== undefined) deleteOptions.auditUserId = auditUserId;
            if (hard) deleteOptions.hard = hard;
            return await this.model.findOneAndDelete(query, deleteOptions).exec();
        };

        let doc: T | null;
        if (timeOperations && logger) {
            const { result } = await timeFunction(
                operation,
                `${this.modelName}.deleteOneOrThrow`,
                { logger, logLevel: 'debug' }
            );
            doc = result;
        } else {
            doc = await operation();
        }

        if (!doc) {
            throw apiValidationException(
                `${lowerFirst(this.modelName)}_not_found`,
                null,
                null,
                languageCode || this.defaultLanguageCode
            );
        }

        return doc;
    }

    /**
     * Delete multiple documents
     * 
     * @param query - MongoDB query
     * @param options - CRUD options
     * @returns Delete result
     */
    async deleteMany(
        query: FilterQuery<T>,
        options: CrudOptions = {}
    ): Promise<{ deletedCount: number }> {
        const { session, logger, timeOperations = true } = options;

        const operation = async () => {
            const deleteOptions: any = {};
            if (session) deleteOptions.session = session;
            if (options.auditUserId !== undefined) deleteOptions.auditUserId = options.auditUserId;
            if (options.hard) deleteOptions.hard = options.hard;
            const result = await this.model.deleteMany(query, deleteOptions);
            return {
                deletedCount: result.deletedCount || 0
            };
        };

        if (timeOperations && logger) {
            const { result } = await timeFunction(
                operation,
                `${this.modelName}.deleteMany`,
                { logger, logLevel: 'debug' }
            );
            return result;
        }

        return await operation();
    }

    /**
     * Count documents
     * 
     * @param query - MongoDB query
     * @param options - CRUD options
     * @returns Count of documents
     */
    async count(
        query: FilterQuery<T> = {},
        options: CrudOptions = {}
    ): Promise<number> {
        const { session, logger, timeOperations = true } = options;

        const operation = async () => {
            let countQuery: any = this.model.countDocuments(query);
            if (session) {
                countQuery = countQuery.session(session);
            }
            return await countQuery.exec();
        };

        if (timeOperations && logger) {
            const { result } = await timeFunction(
                operation,
                `${this.modelName}.count`,
                { logger, logLevel: 'debug' }
            );
            return result;
        }

        return await operation();
    }

    /**
     * Check if document exists
     * 
     * @param query - MongoDB query
     * @param options - CRUD options
     * @returns True if exists, false otherwise
     */
    async exists(
        query: FilterQuery<T>,
        options: CrudOptions = {}
    ): Promise<boolean> {
        const { session, logger, timeOperations = true } = options;

        const operation = async () => {
            let existsQuery: any = this.model.exists(query);
            if (session) {
                existsQuery = existsQuery.session(session);
            }
            const result = await existsQuery.exec();
            return !!result;
        };

        if (timeOperations && logger) {
            const { result } = await timeFunction(
                operation,
                `${this.modelName}.exists`,
                { logger, logLevel: 'debug' }
            );
            return result;
        }

        return await operation();
    }

    /**
     * Perform aggregation pipeline
     * 
     * @param pipeline - MongoDB aggregation pipeline
     * @param options - CRUD options
     * @returns Aggregation results
     * 
     * @example
     * ```typescript
     * const result = await userService.aggregate([
     *     { $match: { active: true } },
     *     { $group: { _id: "$role", count: { $sum: 1 } } }
     * ], { session, logger });
     * ```
     */
    async aggregate(
        pipeline: any[],
        options: CrudOptions = {}
    ): Promise<any[]> {
        const { session, logger, timeOperations = true } = options;

        const operation = async () => {
            let aggregation = this.model.aggregate(pipeline);
            
            if (session) {
                aggregation = aggregation.session(session);
            }
            
            return await aggregation.exec();
        };

        if (timeOperations && logger) {
            const { result } = await timeFunction(
                operation,
                `${this.modelName}.aggregate`,
                { logger, logLevel: 'debug' }
            );
            return result;
        }

        return await operation();
    }

    /**
     * Find multiple documents by IDs
     * 
     * @param ids - Array of document IDs
     * @param options - CRUD options
     * @param populate - Fields to populate
     * @param select - Fields to select
     * @returns Array of documents
     * 
     * @example
     * ```typescript
     * const users = await userService.findByIds([id1, id2, id3], { session, logger });
     * ```
     */
    async findByIds(
        ids: (string | ObjectId)[],
        options: CrudOptions = {},
        populate?: string | string[] | any,
        select?: string | string[]
    ): Promise<T[]> {
        if (ids.length === 0) {
            return [];
        }

        const objectIds = ids.map(id => typeof id === 'string' ? new ObjectId(id) : id);
        return await this.find(
            { _id: { $in: objectIds } },
            options,
            populate,
            select
        );
    }

    /**
     * Bulk update multiple documents
     * 
     * @param updates - Array of {id, update} objects
     * @param options - CRUD options
     * @returns Update result with matched and modified counts
     * 
     * @example
     * ```typescript
     * const result = await userService.bulkUpdate([
     *     { id: id1, update: { $set: { active: true } } },
     *     { id: id2, update: { $set: { active: false } } }
     * ], { session, logger });
     * ```
     */
    async bulkUpdate(
        updates: Array<{id: string | ObjectId; update: UpdateQuery<T>}>,
        options: CrudOptions & QueryOptions = {}
    ): Promise<{ matchedCount: number; modifiedCount: number }> {
        const { session, logger, timeOperations = true } = options;

        const operation = async () => {
            // Use bulkWrite for better performance
            const bulkOps = updates.map(({ id, update }) => ({
                updateOne: {
                    filter: { _id: typeof id === 'string' ? new ObjectId(id) : id },
                    update: update as any
                }
            }));

            const updateOptions: any = { ordered: false };
            if (session) {
                updateOptions.session = session;
            }

            const result = await this.model.bulkWrite(bulkOps as any, updateOptions);
            
            return {
                matchedCount: result.matchedCount,
                modifiedCount: result.modifiedCount
            };
        };

        if (timeOperations && logger) {
            const { result } = await timeFunction(
                operation,
                `${this.modelName}.bulkUpdate`,
                { logger, logLevel: 'debug' }
            );
            return result;
        }

        return await operation();
    }

    /**
     * Bulk delete multiple documents
     * 
     * @param ids - Array of document IDs to delete
     * @param options - CRUD options
     * @returns Delete result with deleted count
     * 
     * @example
     * ```typescript
     * const result = await userService.bulkDelete([id1, id2, id3], { session, logger });
     * ```
     */
    async bulkDelete(
        ids: (string | ObjectId)[],
        options: CrudOptions = {}
    ): Promise<{ deletedCount: number }> {
        if (ids.length === 0) {
            return { deletedCount: 0 };
        }

        const objectIds = ids.map(id => typeof id === 'string' ? new ObjectId(id) : id);
        return await this.deleteMany(
            { _id: { $in: objectIds } },
            options
        );
    }

    /**
     * Upsert a document (update if exists, create if not)
     * 
     * @param query - Query to find existing document
     * @param data - Data to update or create
     * @param options - CRUD options
     * @returns Created or updated document
     * 
     * @example
     * ```typescript
     * const user = await userService.upsert(
     *     { email: 'user@example.com' },
     *     { email: 'user@example.com', name: 'John' },
     *     { session, logger }
     * );
     * ```
     */
    async upsert(
        query: FilterQuery<T>,
        data: Partial<T>,
        options: CrudOptions & QueryOptions = {}
    ): Promise<T> {
        const { session, logger, timeOperations = true } = options;

        const operation = async () => {
            const queryOptions: QueryOptions = { upsert: true, new: true, ...options };
            if (session) {
                queryOptions.session = session;
            }

            return await this.model.findOneAndUpdate(query, data, queryOptions).exec() as T;
        };

        if (timeOperations && logger) {
            const { result } = await timeFunction(
                operation,
                `${this.modelName}.upsert`,
                { logger, logLevel: 'debug' }
            );
            return result;
        }

        return await operation();
    }
}


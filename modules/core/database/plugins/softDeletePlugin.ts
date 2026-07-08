import mongoose, {Query, Schema, SchemaTypes, Types} from "mongoose";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {COLUMN_TYPE} from "armonia/src/modules/core/database/filter/typeOperators";

const DELETED_AT = "deletedAt";
const DELETED_BY = "deletedBy";
const SOFT_DELETE_INCLUDE = "_softDeleteInclude";
const SOFT_DELETE_ONLY = "_softDeleteOnly";
const SOFT_DELETE_FORCE_EXCLUDE = "_softDeleteForceExclude";

export interface SoftDeletePluginOptions {
    /** Add deletedBy field to track who deleted the document (default: true) */
    deletedBy?: boolean;
    /** Index the deletedAt field for query performance (default: true) */
    indexDeletedAt?: boolean;
}

/**
 * Mongoose plugin that implements soft delete.
 *
 * - Adds deletedAt (Date) and optionally deletedBy (ObjectId) fields
 * - Excludes soft-deleted documents from find/findOne/countDocuments by default
 * - Admin users (actionUserCtx.isAdmin in request context) automatically see deleted documents in all queries, including populate refs
 * - Overrides deleteOne, deleteMany, findOneAndDelete (and findByIdAndDelete) to soft delete by default.
 *   Pass { hard: true } in options for physical delete. Pass auditUserId for deletedBy.
 * - Provides withDeleted() and onlyDeleted() query helpers
 * - Provides softDeleteOne, softDeleteMany, restore static methods
 * - Provides softDelete() and restore() instance methods
 *
 * @example
 * // In schema:
 * softDeletePlugin(MySchema);
 * // or with options:
 * softDeletePlugin(MySchema, { deletedBy: true, indexDeletedAt: true });
 *
 * // Query (excludes deleted by default):
 * await MyModel.find({ name: "test" });
 *
 * // Include deleted documents:
 * await MyModel.find({ name: "test" }).withDeleted();
 *
 * // Only deleted documents:
 * await MyModel.find({ name: "test" }).onlyDeleted();
 *
 * // Soft delete:
 * await MyModel.softDeleteOne({ _id: id }, { deletedBy: userId });
 * await doc.softDelete({ deletedBy: userId });
 *
 * // Restore:
 * await MyModel.restore({ _id: id });
 * await doc.restore();
 */
export const softDeletePlugin = (
    schema: Schema,
    options: SoftDeletePluginOptions = {}
): void => {

    // Add soft delete fields
    schema.add({
        [DELETED_AT]: {
            type: SchemaTypes.Date,
            index: true,
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {
                    write: "no-permission"
                }
            },
            dynamicTableConfiguration: {
                visible: false,
                cellType: COLUMN_TYPE.DELETE_STATUS
            }
        },
        [DELETED_BY]: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            permissions: {
                self: {
                    write: "no-permission"
                },
                others: {
                    write: "no-permission"
                }
            },
            refAllowlist: {keys: {name: {}, surname: {}}},
            dynamicTableConfiguration: {
                visible: false,
                refDisplayKey: ["name", "surname"]
            }
        }
    });

    const addSoftDeleteFilter = (query: Query<any, any>) => {
        const includeDeleted = (query as any)[SOFT_DELETE_INCLUDE];
        const onlyDeleted = (query as any)[SOFT_DELETE_ONLY];
        const forceExclude = (query as any)[SOFT_DELETE_FORCE_EXCLUDE];
        const store = requestContext.getStore();
        const includeDeletedForAdmin = store?.actionUserCtx?.isAdmin === true;

        if (onlyDeleted) {
            query.getQuery()[DELETED_AT] = {$ne: null};
            return;
        }

        if (forceExclude || (!includeDeleted && !includeDeletedForAdmin)) {
            const q = query.getQuery();
            if (!(DELETED_AT in q)) {
                query.getQuery()[DELETED_AT] = null;
            }
        }
    };

    const queryMiddleware = function (this: Query<any, any>, next: (err?: any) => void) {
        addSoftDeleteFilter(this);
        next();
    };

    schema.pre("find", queryMiddleware);
    schema.pre("findOne", queryMiddleware);
    schema.pre("countDocuments", queryMiddleware);
    schema.pre("distinct", queryMiddleware);
    schema.pre("findOneAndDelete", queryMiddleware);
    schema.pre("findOneAndUpdate", queryMiddleware);
    schema.pre("updateOne", queryMiddleware);
    schema.pre("updateMany", queryMiddleware);
    schema.pre("replaceOne", queryMiddleware);

    // Query helpers
    (schema.query as any).withDeleted = function (this: Query<any, any>) {
        (this as any)[SOFT_DELETE_INCLUDE] = true;
        delete (this as any)[SOFT_DELETE_ONLY];
        delete (this as any)[SOFT_DELETE_FORCE_EXCLUDE];
        return this;
    };

    (schema.query as any).noDeleted = function (this: Query<any, any>) {
        (this as any)[SOFT_DELETE_FORCE_EXCLUDE] = true;
        delete (this as any)[SOFT_DELETE_INCLUDE];
        delete (this as any)[SOFT_DELETE_ONLY];
        return this;
    };

    (schema.query as any).onlyDeleted = function (this: Query<any, any>) {
        (this as any)[SOFT_DELETE_ONLY] = true;
        delete (this as any)[SOFT_DELETE_INCLUDE];
        delete (this as any)[SOFT_DELETE_FORCE_EXCLUDE];
        return this;
    };

    // Instance methods
    schema.methods.softDelete = async function (options?: {deletedBy?: Types.ObjectId}) {
        const doc = this as any;
        const update: Record<string, unknown> = {
            [DELETED_AT]: new Date(),
        };
        if (options?.deletedBy) {
            update[DELETED_BY] = options.deletedBy;
        }
        doc.set(update);
        return doc.save();
    };

    schema.methods.restore = async function (options?: {session?: any}) {
        const doc = this as any;
        doc.set({
            [DELETED_AT]: null,
            [DELETED_BY]: null
        });
        return doc.save(options);
    };

    // Static methods
    schema.statics.softDeleteOne = async function (filter: Record<string, any>, options?: {deletedBy?: Types.ObjectId; session?: any}) {
        const update: Record<string, unknown> = {
            $set: {
                [DELETED_AT]: new Date(),
                ...(options?.deletedBy && {[DELETED_BY]: options.deletedBy}),
            },
        };
        const session = options?.session;
        return this.updateOne(filter, update, {session}).exec();
    };

    schema.statics.softDeleteMany = async function (filter: Record<string, any>, options?: {deletedBy?: Types.ObjectId; session?: any}) {
        const update: Record<string, unknown> = {
            $set: {
                [DELETED_AT]: new Date(),
                ...(options?.deletedBy && {[DELETED_BY]: options.deletedBy}),
            },
        };
        const session = options?.session;
        return this.updateMany(filter, update, {session}).exec();
    };

    schema.statics.restore = async function (filter: Record<string, any>, options?: {session?: any}) {
        const update: Record<string, unknown> = {
            $set: {
                [DELETED_AT]: null,
                [DELETED_BY]: null
            },
        };
        const session = options?.session;
        return this.updateMany(filter, update, {session}).exec();
    };

    // Override delete methods: soft delete by default, use { hard: true } for physical delete
    const toDeletedBy = (auditUserId: string | Types.ObjectId | undefined): Types.ObjectId | undefined => auditUserId ? (typeof auditUserId === "string" ? new Types.ObjectId(auditUserId) : auditUserId) : undefined;

    const buildSoftUpdate = (opts?: {auditUserId?: string | Types.ObjectId}) => ({
        $set: {
            [DELETED_AT]: new Date(),
            ...(toDeletedBy(opts?.auditUserId) && {[DELETED_BY]: toDeletedBy(opts?.auditUserId)}),
        },
    });

    const withNonDeletedFilter = (filter: Record<string, any>) => {
        const f = {...filter};
        if (!(DELETED_AT in f)) {
            f[DELETED_AT] = null;
        }
        return f;
    };

    schema.statics.deleteOne = function (conditions: Record<string, any>, options: any = {}) {
        const opts = options || {};
        if (opts.hard) {
            const {hard, auditUserId, ...rest} = opts;
            return mongoose.Model.deleteOne.call(this, conditions, rest);
        }
        const update = buildSoftUpdate({auditUserId: opts.auditUserId});
        const {auditUserId, ...rest} = opts;
        const filter = withNonDeletedFilter(conditions);
        return this.updateOne(filter, update, rest).then((result: any) => ({
            acknowledged: result.acknowledged,
            deletedCount: result.modifiedCount ?? 0,
        }));
    };

    schema.statics.deleteMany = function (conditions: Record<string, any>, options: any = {}) {
        const opts = options || {};
        if (opts.hard) {
            const {hard, auditUserId, ...rest} = opts;
            return mongoose.Model.deleteMany.call(this, conditions, rest);
        }
        const update = buildSoftUpdate({auditUserId: opts.auditUserId});
        const {auditUserId, ...rest} = opts;
        const filter = withNonDeletedFilter(conditions);
        return this.updateMany(filter, update, rest).then((result: any) => ({
            acknowledged: result.acknowledged,
            deletedCount: result.modifiedCount ?? 0,
        }));
    };

    schema.statics.findOneAndDelete = function (conditions: Record<string, any>, options: any = {}) {
        const opts = options || {};
        if (opts.hard) {
            const {hard, auditUserId, ...rest} = opts;
            return mongoose.Model.findOneAndDelete.call(this, conditions, rest);
        }
        const update = buildSoftUpdate({auditUserId: opts.auditUserId});
        const {auditUserId, ...rest} = opts;
        const filter = withNonDeletedFilter(conditions);
        const updateOptions = {...rest, new: true};
        return this.findOneAndUpdate(filter, update, updateOptions);
    };
};

export default softDeletePlugin;

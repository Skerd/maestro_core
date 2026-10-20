import {ObjectId} from "mongodb";
import type {Document, Model} from "mongoose";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import type {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import type {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import type {RestoreForm, RestoreResponse} from "armonia/src/modules/core/types/shared.types";

/**
 * Restore handler (`overrideRestoreHandler`) for models whose unique keys only
 * cover live rows: a deleted row's code can be reused, so restoring it is refused
 * while a live row holds one of its keys (instead of failing on the index).
 * Keys are strings (codes) or refs (e.g. one review per order); `sharedKeys` are
 * the other fields of a compound index (one flag per listing *and user*).
 * `afterRestore` gets the row as it was while deleted, to bring back what its
 * delete took with it.
 */
export function restoreUnlessKeyTaken<T extends Document>(config: {
    model: Model<T>;
    service: BaseCrudService<T, Model<T>>;
    entityName: string;
    keys: string[];
    sharedKeys?: string[];
    errorCode: string;
    afterRestore?: (deleted: T, params: TransactionRequiredParams & RestoreForm) => Promise<void>;
}) {
    const {model, service, entityName, keys, sharedKeys = [], errorCode, afterRestore} = config;

    return async (params: TransactionRequiredParams & RestoreForm): Promise<RestoreResponse> => {
        const {logger, languageCode, session, _id, company, actionUserCtx} = params;
        SchemaGuard.checkModelPermission(model, "restore", actionUserCtx, languageCode);

        const filter = {_id: new ObjectId(_id), company: company._id};
        const deleted = await service.findOneOrThrow(filter, {session, logger, languageCode, withDeleted: true});

        const taken = keys.flatMap(key => {
            const value = deleted.get(key);
            return value instanceof ObjectId || (typeof value === "string" && value !== "") ? [{[key]: value}] : [];
        });
        const shared = Object.fromEntries(sharedKeys.map(key => [key, deleted.get(key)]));
        const conflict: Record<string, unknown> = {company: company._id, _id: {$ne: deleted._id}, deletedAt: null, ...shared, $or: taken};
        if (taken.length && await service.exists(conflict, {session, logger, languageCode})) {
            throw apiValidationException(errorCode, "", null, languageCode);
        }

        await service.restoreOneOrThrow(filter, {session, logger, languageCode, auditUserId: actionUserCtx.userId});
        await afterRestore?.(deleted, params);
        return {message: `${entityName} successfully restored`};
    };
}

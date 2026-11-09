import {Types} from "mongoose";
import CompanyDataKey from "@coreModule/database/schemas/companyDataKey/companyDataKey";

/** Health-data keys (D102). Callers run these as the key's company (`withTenant`), or cross-tenant for a rotation. */
export const companyDataKeyService = {
    findForCompany(company: Types.ObjectId) {
        return CompanyDataKey.find({company}).sort({version: 1}).lean();
    },

    async create(entry: {company: Types.ObjectId; version: number; wrappedKey: string; masterKeyId: string}): Promise<void> {
        await CompanyDataKey.create(entry);
    },

    /** Every key not wrapped by `masterKeyId`, of every company (master-key rotation). */
    findWrappedByOtherMasterKey(masterKeyId: string) {
        return CompanyDataKey.find({masterKeyId: {$ne: masterKeyId}}).lean();
    },

    async rewrap(id: Types.ObjectId, wrappedKey: string, masterKeyId: string): Promise<void> {
        await CompanyDataKey.updateOne({_id: id}, {$set: {wrappedKey, masterKeyId}});
    },
};

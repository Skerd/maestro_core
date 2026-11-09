import {Document, model, Schema, SchemaTypes} from "mongoose";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import {ILifeCyclePluginFields, IOwnershipPluginFields, ISoftDeletePluginFields} from "@coreModule/database/types/plugin-fields";
import {applyCompanyDataKeyIndexes} from "./companyDataKey.indexes";

/**
 * A company's key for its health data (D102): AES-256 key bytes wrapped (AES-256-GCM) by the server's master key.
 * Created on the company's first encryption; never readable or writable through the API (no permissions, no route).
 */
export interface ICompanyDataKey extends Document, IOwnershipPluginFields, ISoftDeletePluginFields, ILifeCyclePluginFields {
    /** Starts at 1; encrypted values name the version they were sealed with. */
    version: number;
    /** `iv.tag.ciphertext`, base64url. */
    wrappedKey: string;
    /** Fingerprint of the master key that wrapped it, so a rotation knows which keys still need rewrapping. */
    masterKeyId: string;
}

const CompanyDataKeySchema = new Schema<ICompanyDataKey>({
    version: {type: SchemaTypes.Number, required: true, min: 1},
    wrappedKey: {type: SchemaTypes.String, required: true},
    masterKeyId: {type: SchemaTypes.String, required: true},
});

ownershipPlugin(CompanyDataKeySchema);
auditPlugin(CompanyDataKeySchema);
softDeletePlugin(CompanyDataKeySchema);
lifeCyclePlugin(CompanyDataKeySchema);
applyCompanyDataKeyIndexes(CompanyDataKeySchema);
const CompanyDataKey = model<ICompanyDataKey>("CompanyDataKey", CompanyDataKeySchema);
export default CompanyDataKey;

import {Document, model, Schema, SchemaTypes} from "mongoose";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import platformOnlyPlugin from "@coreModule/database/plugins/platformOnlyPlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import {ILifeCyclePluginFields, IOwnershipPluginFields, ISoftDeletePluginFields} from "@coreModule/database/types/plugin-fields";
import {addModelData} from "@coreModule/database/collections";
import {applyUploadRefusalIndexes} from "@coreModule/database/schemas/uploadRefusal/uploadRefusal.indexes";
import type {UploadReviewScores} from "armonia/src/modules/core/api/auxiliary/private/uploadReview/uploadReview.dto";

/** The refusals the content check makes (D177): an explicit image, video, or document picture. */
export const UPLOAD_REFUSAL_CODES = ["file_explicit_content", "video_explicit_content", "document_explicit_content"] as const;

const serverWritten = {
    self: {write: "no-permission"},
    others: {write: "no-permission"},
};

/**
 * An upload the content check refused (D177), for the platform's upload review: who sent what, where and with which
 * scores. The file itself is never kept, only its SHA-256 to recognise it again. Written by `mediaUploadMW` in the
 * uploading company, read by the platform across companies.
 */
export interface IUploadRefusal extends Document, IOwnershipPluginFields, ISoftDeletePluginFields, ILifeCyclePluginFields {
    fileName: string;
    mimeType: string;
    fileSize: number;
    fileHash: string;
    /** The API path the file was sent to. */
    route: string;
    errorCode: (typeof UPLOAD_REFUSAL_CODES)[number];
    scores: UploadReviewScores;
}

const UploadRefusalSchema = new Schema<IUploadRefusal>(
    {
        fileName: {type: SchemaTypes.String, required: true, trim: true, maxlength: 512, permissions: serverWritten},
        mimeType: {type: SchemaTypes.String, required: true, maxlength: 255, permissions: serverWritten},
        fileSize: {type: SchemaTypes.Number, required: true, min: 0, permissions: serverWritten},
        fileHash: {type: SchemaTypes.String, required: true, maxlength: 64, permissions: serverWritten},
        route: {type: SchemaTypes.String, required: true, maxlength: 512, permissions: serverWritten},
        errorCode: {type: SchemaTypes.String, required: true, enum: [...UPLOAD_REFUSAL_CODES], permissions: serverWritten},
        scores: {type: SchemaTypes.Mixed, required: true, permissions: serverWritten},
    },
    {
        accessMode: "loose",
        permissions: {
            self: {
                create: "no-permission",
                delete: "no-permission",
                restore: "no-permission",
            },
        },
    },
);

ownershipPlugin(UploadRefusalSchema);
// The platform's (D161): only the platform company reviews uploads.
platformOnlyPlugin(UploadRefusalSchema);
auditPlugin(UploadRefusalSchema);
softDeletePlugin(UploadRefusalSchema);
lifeCyclePlugin(UploadRefusalSchema);
applyUploadRefusalIndexes(UploadRefusalSchema);
const UploadRefusal = model<IUploadRefusal>("UploadRefusal", UploadRefusalSchema);
normalizeSchemaPermissions(UploadRefusal);
export default UploadRefusal;

addModelData(UploadRefusal);

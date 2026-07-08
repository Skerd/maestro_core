import {Document, model, Schema, SchemaTypes} from "mongoose";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import {IOwnershipPluginFields, ISoftDeletePluginFields} from "@coreModule/database/types/plugin-fields";
import {addModelData} from "@coreModule/database/collections";
import {smtpServerViews} from "@coreModule/database/schemas/smtpServer/smtpServer.views";
import {applySmtpServerIndexes} from "@coreModule/database/schemas/smtpServer/smtpServer.indexes";
import {validateSchemaDefAgainstMongoose} from "@coreModule/database/utilities/validateSchemaDefAgainstMongoose";
import {SmtpServerSchemaDef} from "armonia/src/modules/core/api/auxiliary/private/smtpServer/smtpServer.schema-def";
import type {SmtpAuthType, SmtpEncryptionType, SmtpTestStatus} from "armonia/src/modules/core/api/auxiliary/private/smtpServer/smtpServer.constants";

export interface ISmtpServer extends Document, IOwnershipPluginFields, ISoftDeletePluginFields {
    name: string;
    sequence: number;
    active: boolean;
    host: string;
    port: number;
    encryption: SmtpEncryptionType;
    authType: SmtpAuthType;
    username?: string;
    passwordEncrypted?: string;
    fromEmail: string;
    fromName?: string;
    replyTo?: string;
    lastTestedAt?: Date;
    lastTestStatus?: SmtpTestStatus;
    lastTestMessage?: string;
}

const SmtpServerSchema = new Schema<ISmtpServer>(
    {
        name: {
            type: SchemaTypes.String,
            required: true,
            trim: true,
            dynamicTableConfiguration: {filterable: true, sortable: true},
        },
        sequence: {
            type: SchemaTypes.Number,
            required: true,
            default: 10,
            min: 0,
            dynamicTableConfiguration: {filterable: false, sortable: true},
        },
        active: {
            type: SchemaTypes.Boolean,
            required: true,
            default: true,
            dynamicTableConfiguration: {filterable: true, sortable: true},
        },
        host: {
            type: SchemaTypes.String,
            required: true,
            trim: true,
            dynamicTableConfiguration: {filterable: true, sortable: true},
        },
        port: {
            type: SchemaTypes.Number,
            required: true,
            min: 1,
            max: 65535,
            dynamicTableConfiguration: {filterable: false, sortable: true},
        },
        encryption: {
            type: SchemaTypes.String,
            required: true,
            enum: ["none", "ssl", "starttls"],
            dynamicTableConfiguration: {filterable: true, sortable: true},
        },
        authType: {
            type: SchemaTypes.String,
            required: true,
            enum: ["login", "none"],
            default: "login",
            dynamicTableConfiguration: {filterable: true, sortable: true},
        },
        username: {
            type: SchemaTypes.String,
            required: false,
            trim: true,
            dynamicTableConfiguration: {filterable: false, sortable: false, hideColumn: true},
        },
        passwordEncrypted: {
            type: SchemaTypes.String,
            required: false,
            permissions: {
                self: {read: "no-permission", write: "no-permission"},
                others: {read: "no-permission", write: "no-permission"},
            },
        },
        fromEmail: {
            type: SchemaTypes.String,
            required: true,
            trim: true,
            lowercase: true,
            dynamicTableConfiguration: {filterable: false, sortable: true},
        },
        fromName: {
            type: SchemaTypes.String,
            required: false,
            trim: true,
            default: "",
            dynamicTableConfiguration: {filterable: false, sortable: false, hideColumn: true},
        },
        replyTo: {
            type: SchemaTypes.String,
            required: false,
            trim: true,
            lowercase: true,
            dynamicTableConfiguration: {filterable: false, sortable: false, hideColumn: true},
        },
        lastTestedAt: {
            type: SchemaTypes.Date,
            required: false,
            permissions: {
                self: {write: "no-permission"},
                others: {write: "no-permission"},
            },
            dynamicTableConfiguration: {filterable: false, sortable: true},
        },
        lastTestStatus: {
            type: SchemaTypes.String,
            required: false,
            enum: ["ok", "failed"],
            permissions: {
                self: {write: "no-permission"},
                others: {write: "no-permission"},
            },
            dynamicTableConfiguration: {filterable: false, sortable: true},
        },
        lastTestMessage: {
            type: SchemaTypes.String,
            required: false,
            default: "",
            permissions: {
                self: {write: "no-permission"},
                others: {write: "no-permission"},
            },
            dynamicTableConfiguration: {filterable: false, sortable: false, hideColumn: true},
        },
    },
    {accessMode: "loose"},
);

ownershipPlugin(SmtpServerSchema);
auditPlugin(SmtpServerSchema);
softDeletePlugin(SmtpServerSchema);
applySmtpServerIndexes(SmtpServerSchema);
const SmtpServer = model<ISmtpServer>("SmtpServer", SmtpServerSchema);
normalizeSchemaPermissions(SmtpServer);
export default SmtpServer;

addModelData(SmtpServer, smtpServerViews);
validateSchemaDefAgainstMongoose(SmtpServerSchema, SmtpServerSchemaDef, "SmtpServer", ["passwordEncrypted", "lastTestedAt", "lastTestStatus", "lastTestMessage",]);

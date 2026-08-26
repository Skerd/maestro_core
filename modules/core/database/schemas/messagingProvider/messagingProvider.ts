import {Document, model, Schema, SchemaTypes} from "mongoose";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import {
    ILifeCyclePluginFields,
    IOwnershipPluginFields,
    ISoftDeletePluginFields
} from "@coreModule/database/types/plugin-fields";
import {addModelData} from "@coreModule/database/collections";
import {validateSchemaDefAgainstMongoose} from "@coreModule/database/utilities/validateSchemaDefAgainstMongoose";
import {
    MessagingProviderSchemaDef,
    MESSAGING_PROVIDER_ACCOUNT_SID_MAX,
    MESSAGING_PROVIDER_NAME_MAX,
    MESSAGING_PROVIDER_PHONE_MAX,
} from "armonia/src/modules/core/api/auxiliary/private/messagingProvider/messagingProvider.schema-def";
import {messagingProviderViews} from "@coreModule/database/schemas/messagingProvider/messagingProvider.views";
import {ICompany} from "@coreModule/database/schemas/company/company";

export interface IMessagingProvider extends Document, IOwnershipPluginFields, ISoftDeletePluginFields, ILifeCyclePluginFields {
    name: string;
    providerType: string;
    accountSid: string;
    authTokenEncrypted?: string;
    fromPhone?: string;
    fromWhatsapp?: string;
    active: boolean;
    company: ICompany;
    lastTestedAt?: Date;
    lastTestStatus?: string;
    lastTestMessage?: string;
}

const MessagingProviderSchema = new Schema<IMessagingProvider>(
    {
        name: {
            type: SchemaTypes.String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: MESSAGING_PROVIDER_NAME_MAX,
            dynamicTableConfiguration: {filterable: true, sortable: true},
        },
        providerType: {
            type: SchemaTypes.String,
            required: true,
            enum: ["twilio"],
            dynamicTableConfiguration: {filterable: true, sortable: true},
        },
        accountSid: {
            type: SchemaTypes.String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: MESSAGING_PROVIDER_ACCOUNT_SID_MAX,
            dynamicTableConfiguration: {filterable: true, sortable: true},
        },
        authTokenEncrypted: {
            type: SchemaTypes.String,
            required: false,
            permissions: {
                self:   {write: "no-permission", publicRead: false},
                others: {write: "no-permission", publicRead: false},
            },
            dynamicTableConfiguration: {
                filterable: false,
                sortable: false,
                hideColumn: true
            }
        },
        fromPhone: {
            type: SchemaTypes.String,
            required: false,
            trim: true,
            maxlength: MESSAGING_PROVIDER_PHONE_MAX,
            dynamicTableConfiguration: {filterable: true, sortable: true},
        },
        fromWhatsapp: {
            type: SchemaTypes.String,
            required: false,
            trim: true,
            maxlength: MESSAGING_PROVIDER_PHONE_MAX,
            dynamicTableConfiguration: {filterable: true, sortable: true},
        },
        active: {
            type: SchemaTypes.Boolean,
            required: true,
            default: true,
            dynamicTableConfiguration: {filterable: true, sortable: true},
        },
        lastTestedAt: {
            type: SchemaTypes.Date,
            required: false,
            permissions: {self: {write: "no-permission"}, others: {write: "no-permission"}},
            dynamicTableConfiguration: {filterable: false, sortable: true},
        },
        lastTestStatus: {
            type: SchemaTypes.String,
            required: false,
            permissions: {self: {write: "no-permission"}, others: {write: "no-permission"}},
            dynamicTableConfiguration: {filterable: true, sortable: true},
        },
        lastTestMessage: {
            type: SchemaTypes.String,
            required: false,
            permissions: {self: {write: "no-permission"}, others: {write: "no-permission"}},
            dynamicTableConfiguration: {filterable: false, sortable: false, hideColumn: true},
        },
    },
    {accessMode: "loose"}
);

ownershipPlugin(MessagingProviderSchema);
auditPlugin(MessagingProviderSchema);
softDeletePlugin(MessagingProviderSchema);
lifeCyclePlugin(MessagingProviderSchema);

const MessagingProvider = model<IMessagingProvider>("MessagingProvider", MessagingProviderSchema);
normalizeSchemaPermissions(MessagingProvider);
export default MessagingProvider;

addModelData(MessagingProvider, messagingProviderViews);
validateSchemaDefAgainstMongoose(MessagingProviderSchema, MessagingProviderSchemaDef, "MessagingProvider", ["authTokenEncrypted", "active", "lastTestedAt", "lastTestStatus", "lastTestMessage"]);

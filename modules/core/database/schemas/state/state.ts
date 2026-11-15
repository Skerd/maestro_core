import {Document, model, Schema, SchemaTypes} from "mongoose";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import requestablePlugin, {type IRequestablePluginFields} from "@coreModule/database/plugins/requestablePlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import {
    ILifeCyclePluginFields,
    IOwnershipPluginFields,
    ISoftDeletePluginFields
} from "@coreModule/database/types/plugin-fields";
import {ICountry} from "@coreModule/database/schemas/country/country";
import {CountrySimpleSnippet} from "@coreModule/database/schemas/country/country.snippets";
import {addModelData} from "@coreModule/database/collections";
import {stateViews} from "@coreModule/database/schemas/state/state.views";
import {applyStateIndexes} from "@coreModule/database/schemas/state/state.indexes";
import {validateSchemaDefAgainstMongoose} from "@coreModule/database/utilities/validateSchemaDefAgainstMongoose";
import {
    StateSchemaDef,
    STATE_CODE_MAX,
    STATE_NAME_MAX,
} from "armonia/src/modules/core/api/auxiliary/private/state/state.schema-def";

export interface IState extends Document, IOwnershipPluginFields, IRequestablePluginFields, ISoftDeletePluginFields, ILifeCyclePluginFields {
    name: string;
    code?: string;
    country: ICountry;
}

const StateSchema = new Schema<IState>(
    {
        name: {
            type: SchemaTypes.String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: STATE_NAME_MAX,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true
                }
            }
        },
        code: {
            type: SchemaTypes.String,
            trim: true,
            maxlength: STATE_CODE_MAX,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true
                }
            }
        },
        country: {
            type: SchemaTypes.ObjectId,
            ref: "Country",
            required: true,
            refAllowlist: CountrySimpleSnippet,
            permissions: {
                self: {
                    publicRead: true
                }
            },
            dynamicTableConfiguration: {
                dtoPath: "country",
                refDisplayKey: ["name", "code"]
            }
        }
    },
    {
        accessMode: "loose"
    }
);

// A platform list (D160): the platform company owns every row and every company reads and links to them.
ownershipPlugin(StateSchema, {tenantScoped: false});
// Another company asks for a missing entry with the list's own create form; the platform approves it.
requestablePlugin(StateSchema);
auditPlugin(StateSchema);
softDeletePlugin(StateSchema);
lifeCyclePlugin(StateSchema);
applyStateIndexes(StateSchema);
const State = model<IState>("State", StateSchema);
normalizeSchemaPermissions(State);
export default State;

addModelData(State, stateViews);
validateSchemaDefAgainstMongoose(StateSchema, StateSchemaDef, "State");

import {Document, model, Schema, SchemaTypes} from "mongoose";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import {IOwnershipPluginFields, ISoftDeletePluginFields} from "@coreModule/database/types/plugin-fields";
import {IState} from "@coreModule/database/schemas/state/state";
import {ICountry} from "@coreModule/database/schemas/country/country";
import {StateSimpleSnippet} from "@coreModule/database/schemas/state/state.snippets";
import {CountrySimpleSnippet} from "@coreModule/database/schemas/country/country.snippets";
import {addModelData} from "@coreModule/database/collections";
import {cityViews} from "@coreModule/database/schemas/city/city.views";
import {applyCityIndexes} from "@coreModule/database/schemas/city/city.indexes";
import {validateSchemaDefAgainstMongoose} from "@coreModule/database/utilities/validateSchemaDefAgainstMongoose";
import {CitySchemaDef} from "armonia/src/modules/core/api/auxiliary/private/city/city.schema-def";

export interface ICity extends Document, IOwnershipPluginFields, ISoftDeletePluginFields {
    name: string;
    state?: IState;
    country: ICountry;
}

const CitySchema = new Schema<ICity>(
    {
        name: {
            type: SchemaTypes.String,
            required: true,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                },
            },
        },
        state: {
            type: SchemaTypes.ObjectId,
            ref: "State",
            required: false,
            refAllowlist: StateSimpleSnippet,
            permissions: {
                self: {
                    publicRead: true,
                },
            },
            dynamicTableConfiguration: {
                dtoPath: "state",
                refDisplayKey: ["name"],
            },
        },
        country: {
            type: SchemaTypes.ObjectId,
            ref: "Country",
            required: true,
            refAllowlist: CountrySimpleSnippet,
            permissions: {
                self: {
                    publicRead: true,
                },
            },
            dynamicTableConfiguration: {
                dtoPath: "country",
                refDisplayKey: ["name"],
            },
        },
    },
    {
        accessMode: "loose",
    }
);

ownershipPlugin(CitySchema);
auditPlugin(CitySchema);
softDeletePlugin(CitySchema);
applyCityIndexes(CitySchema);
const City = model<ICity>("City", CitySchema);
normalizeSchemaPermissions(City);
export default City;

addModelData(City, cityViews);
validateSchemaDefAgainstMongoose(CitySchema, CitySchemaDef, "City");

import {Document, model, Schema, SchemaTypes} from "mongoose";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import {IOwnershipPluginFields, ISoftDeletePluginFields} from "@coreModule/database/types/plugin-fields";
import {addModelData} from "@coreModule/database/collections";
import {countryViews} from "@coreModule/database/schemas/country/country.views";
import {applyCountryIndexes} from "@coreModule/database/schemas/country/country.indexes";
import {validateSchemaDefAgainstMongoose} from "@coreModule/database/utilities/validateSchemaDefAgainstMongoose";
import {CountrySchemaDef} from "armonia/src/modules/core/api/auxiliary/private/country/country.schema-def";

export interface ICountry extends Document, IOwnershipPluginFields, ISoftDeletePluginFields {
    name: string;
    code: string;
    phoneCode?: string;
}

const CountrySchema = new Schema<ICountry>(
    {
        name: {
            type: SchemaTypes.String,
            required: true,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true
                }
            }
        },
        code: {
            type: SchemaTypes.String,
            required: true,
            uppercase: true,
            minlength: 2,
            maxlength: 3,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true
                }
            }
        },
        phoneCode: {
            type: SchemaTypes.String,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true
                }
            }
        }
    },
    {
        accessMode: "loose",
    }
);

ownershipPlugin(CountrySchema);
auditPlugin(CountrySchema);
softDeletePlugin(CountrySchema);
applyCountryIndexes(CountrySchema);
const Country = model<ICountry>("Country", CountrySchema);
normalizeSchemaPermissions(Country);
export default Country;

addModelData(Country, countryViews);
validateSchemaDefAgainstMongoose(CountrySchema, CountrySchemaDef, "Country");

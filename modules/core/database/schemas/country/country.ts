import {Document, model, Schema, SchemaTypes} from "mongoose";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import {
    ILifeCyclePluginFields,
    IOwnershipPluginFields,
    ISoftDeletePluginFields
} from "@coreModule/database/types/plugin-fields";
import {addModelData} from "@coreModule/database/collections";
import {countryViews} from "@coreModule/database/schemas/country/country.views";
import {applyCountryIndexes} from "@coreModule/database/schemas/country/country.indexes";
import {validateSchemaDefAgainstMongoose} from "@coreModule/database/utilities/validateSchemaDefAgainstMongoose";
import {
    CountrySchemaDef,
    COUNTRY_CODE_MAX,
    COUNTRY_CODE_MIN,
    COUNTRY_NAME_MAX,
    COUNTRY_PHONE_CODE_MAX,
} from "armonia/src/modules/core/api/auxiliary/private/country/country.schema-def";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";

export interface ICountry extends Document, IOwnershipPluginFields, ISoftDeletePluginFields, ILifeCyclePluginFields {
    name: string;
    code: string;
    phoneCode?: string;
}

const CountrySchema = new Schema<ICountry>(
    {
        name: {
            type: SchemaTypes.String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: COUNTRY_NAME_MAX,
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
            trim: true,
            minlength: COUNTRY_CODE_MIN,
            maxlength: COUNTRY_CODE_MAX,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true
                }
            }
        },
        phoneCode: {
            type: SchemaTypes.String,
            trim: true,
            maxlength: COUNTRY_PHONE_CODE_MAX,
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
lifeCyclePlugin(CountrySchema);
applyCountryIndexes(CountrySchema);
const Country = model<ICountry>("Country", CountrySchema);
normalizeSchemaPermissions(Country);
export default Country;

addModelData(Country, countryViews);
validateSchemaDefAgainstMongoose(CountrySchema, CountrySchemaDef, "Country");

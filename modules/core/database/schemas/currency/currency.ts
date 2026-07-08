import {Document, model, Schema, SchemaTypes} from "mongoose";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import {IOwnershipPluginFields, ISoftDeletePluginFields} from "@coreModule/database/types/plugin-fields";
import {addModelData} from "@coreModule/database/collections";
import {currencyViews} from "@coreModule/database/schemas/currency/currency.views";
import {applyCurrencyIndexes} from "@coreModule/database/schemas/currency/currency.indexes";
import {validateSchemaDefAgainstMongoose} from "@coreModule/database/utilities/validateSchemaDefAgainstMongoose";
import {CurrencySchemaDef} from "armonia/src/modules/core/api/finance/private/currency/currency.schema-def";

export interface ICurrency extends Document, IOwnershipPluginFields, ISoftDeletePluginFields {
    name: string;
    symbol: string;
    decimalPlaces: number;
    abbreviation: string;
}

const CurrencySchema = new Schema<ICurrency>(
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
        symbol: {
            type: SchemaTypes.String,
            required: true,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                },
            },
        },
        decimalPlaces: {
            type: SchemaTypes.Number,
            required: true,
            default: 2,
            min: 0,
            max: 8,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                },
            },
        },
        abbreviation: {
            type: SchemaTypes.String,
            required: true,
            uppercase: true,
            dynamicTableConfiguration: {},
            permissions: {
                self: {
                    publicRead: true,
                },
            },
        },
    },
    {
        accessMode: "loose",
    }
);

ownershipPlugin(CurrencySchema);
auditPlugin(CurrencySchema);
softDeletePlugin(CurrencySchema);
applyCurrencyIndexes(CurrencySchema);
const Currency = model<ICurrency>("Currency", CurrencySchema);
normalizeSchemaPermissions(Currency);
export default Currency;

addModelData(Currency, currencyViews);
validateSchemaDefAgainstMongoose(CurrencySchema, CurrencySchemaDef, "Currency");

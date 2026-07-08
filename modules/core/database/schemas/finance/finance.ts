import mongoose, {Document, SchemaTypes} from "mongoose";
import {Decimal128} from "mongodb";
import {ICurrency} from "@coreModule/database/schemas/currency/currency";
import {applyFinanceIndexes} from "./finance.indexes";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import {IOwnershipPluginFields} from "@coreModule/database/types/plugin-fields";

export interface FinanceCurrencies {
    amount: Decimal128,
    currency: ICurrency
}

export interface IFinance extends Document, IOwnershipPluginFields {
    currencies: FinanceCurrencies[]
}

const FinanceSchema = new mongoose.Schema<IFinance>(
    {
        currencies: {
            type: [
                {
                    amount: {
                        type: SchemaTypes.Decimal128,
                        required: true,
                        get: (v: Decimal128) => v ? parseFloat(v.toString()) : null,
                        set: (v: number | string | Decimal128) => {
                            if (v instanceof Decimal128) return v;
                            return Decimal128.fromString(v.toString());
                        },
                        validate: {
                            validator: function(value: Decimal128) {
                                if (!value) return false;
                                const numValue = parseFloat(value.toString());
                                return numValue >= 0;
                            },
                            message: 'Amount must be non-negative'
                        }
                    },
                    currency: {
                        type: SchemaTypes.ObjectId,
                        ref: "Currency",
                        required: true
                    }
                }
            ]
        }
    },
    {
        permissions: {
            self: {
                create: "no-permission",
                delete: "no-permission",
                restore: "no-permission"
            },
            others: {
                create: "no-permission",
                delete: "no-permission",
                restore: "no-permission"
            }
        }
    }
);

ownershipPlugin(FinanceSchema, {self: {read: "no-permission", write: "no-permission"}, others: {read: "no-permission", write: "no-permission"}});
auditPlugin(FinanceSchema);
applyFinanceIndexes(FinanceSchema);
const Finance = mongoose.model<IFinance>("Finance", FinanceSchema);
normalizeSchemaPermissions(Finance);
export default Finance;
// Finance.syncIndexes(); // Uncomment to manually sync indexes
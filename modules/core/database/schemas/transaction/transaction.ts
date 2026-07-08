import mongoose, {Document, SchemaTypes} from "mongoose";
import {Decimal128, ObjectId} from "mongodb";
import {ICurrency} from "@coreModule/database/schemas/currency/currency";
import {IUser} from "@coreModule/database/schemas/user/user";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {applyTransactionIndexes} from "./transaction.indexes";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import {IOwnershipPluginFields} from "@coreModule/database/types/plugin-fields";

export enum TransactionStatus {
    INITIALIZED = "initialized",
    PENDING = "pending",
    COMPLETED = "completed",
    CANCELED = "canceled",
    FAILED = "failed"
}

export enum TransactionType {
    BET = "bet",
    DEPOSIT = "deposit",
    WITHDRAWAL = "withdrawal",
    BONUS = "bonus",
    WIN = "win",
    LOSS = "loss",
    REFUND = "refund",
    TRANSFER = "transfer"
}

export interface ITransaction extends Document, IOwnershipPluginFields {
    amount: Decimal128,
    currency: ICurrency,
    sender: IUser,
    receiver: IUser,
    senderFinance?: ObjectId,
    receiverFinance?: ObjectId,
    date: Date,
    status: TransactionStatus,
    type: TransactionType,
    company: ICompany,
    relatedTransactionId?: ObjectId,
}

export const TransactionSchema = new mongoose.Schema<ITransaction>(
    {
        amount: {
            type: SchemaTypes.Decimal128,
            required: true,
            // get: (v: Decimal128) => v ? parseFloat(v.toString()) : null,
            set: (v: number | string | Decimal128) => {
                if (v instanceof Decimal128) return v;
                return Decimal128.fromString(v.toString());
            },
            validate: {
                validator: function(value: Decimal128) {
                    if (!value) return false;
                    const numValue = parseFloat(value.toString());
                    return numValue > 0;
                },
                message: 'Amount must be positive'
            },
            permissions: {
                self: {
                    write: "no-permission",
                },
                others: {
                    write: "no-permission",
                }
            }
        },
        currency: {
            type: SchemaTypes.ObjectId,
            ref: "Currency",
            required: true,
            permissions: {
                self: {
                    write: "no-permission",
                },
                others: {
                    write: "no-permission",
                }
            }
        },
        sender: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            required: true,
            permissions: {
                self: {
                    write: "no-permission",
                },
                others: {
                    write: "no-permission",
                }
            }
        },
        receiver: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            required: true,
            permissions: {
                self: {
                    write: "no-permission",
                },
                others: {
                    write: "no-permission",
                }
            }
        },
        date: {
            type: SchemaTypes.Date,
            required: true,
            default: Date.now,
            permissions: {
                self: {
                    write: "no-permission",
                },
                others: {
                    write: "no-permission",
                }
            }
        },
        senderFinance: {
            type: SchemaTypes.ObjectId,
            ref: "Finance",
            required: false,
            permissions: {
                self: {
                    write: "no-permission",
                },
                others: {
                    write: "no-permission",
                }
            }
        },
        receiverFinance: {
            type: SchemaTypes.ObjectId,
            ref: "Finance",
            required: false,
            permissions: {
                self: {
                    write: "no-permission",
                },
                others: {
                    write: "no-permission",
                }
            }
        },
        status: {
            type: SchemaTypes.String,
            enum: Object.values(TransactionStatus),
            required: true,
            default: TransactionStatus.PENDING,
            permissions: {
                self: {
                    write: "no-permission",
                },
                others: {
                    write: "no-permission",
                }
            }
        },
        type: {
            type: SchemaTypes.String,
            enum: Object.values(TransactionType),
            required: true,
            permissions: {
                self: {
                    write: "no-permission",
                },
                others: {
                    write: "no-permission",
                }
            }
        },
        relatedTransactionId: {
            type: SchemaTypes.ObjectId,
            ref: "Transaction",
            required: false,
            permissions: {
                self: {
                    write: "no-permission",
                },
                others: {
                    write: "no-permission",
                }
            }
        }
    },
    {
        permissions: {
            self: {
                delete: "no-permission",
                restore: "no-permission"
            },
            others: {
                delete: "no-permission",
                restore: "no-permission"
            }
        }
    }
);

ownershipPlugin(TransactionSchema);
auditPlugin(TransactionSchema);
applyTransactionIndexes(TransactionSchema);
const Transaction = mongoose.model<ITransaction>("Transaction", TransactionSchema);
normalizeSchemaPermissions(Transaction);
export default Transaction;
// Transaction.syncIndexes(); // Uncomment to manually sync indexes

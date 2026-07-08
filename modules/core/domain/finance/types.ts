import {Decimal128, ObjectId} from "mongodb";
import {TransactionType} from "@coreModule/database/schemas/transaction/transaction";

/**
 * Finance Domain Types
 * 
 * Type definitions for finance domain operations
 */

export interface BalanceResult {
    success: boolean;
    newBalance: Decimal128;
    reason?: string;
}

export interface TransferRequest {
    fromFinanceId: ObjectId;
    toFinanceId: ObjectId;
    currencyId: ObjectId;
    amount: Decimal128;
    transactionType: TransactionType;
    companyId: ObjectId;
    senderUserId: ObjectId;
    receiverUserId: ObjectId;
    relatedTransactionId?: ObjectId;
}

export interface TransactionRequest {
    financeId: ObjectId;
    currencyId: ObjectId;
    amount: Decimal128;
    transactionType: TransactionType;
    companyId: ObjectId;
    userId: ObjectId;
    relatedUserId?: ObjectId;
    relatedTransactionId?: ObjectId;
    description?: string;
}

export interface IdempotencyKey {
    key: string;
    result: any;
    ttl: number; // seconds
}


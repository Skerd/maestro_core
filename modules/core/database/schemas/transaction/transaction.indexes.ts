import {Schema} from "mongoose";

/**
 * Optimized Transaction Indexes
 * 
 * Reduced from 51 indexes to 6 optimized compound indexes that support all common query patterns.
 * This reduces write overhead significantly while maintaining query performance.
 */
export function applyTransactionIndexes(TransactionSchema: Schema): void {
    // PRIMARY INDEXES - Support all common query patterns
    
    // 1. User sent transactions (most common query)
    TransactionSchema.index({ sender: 1, company: 1, date: -1 });
    
    // 2. User received transactions (most common query)
    TransactionSchema.index({ receiver: 1, company: 1, date: -1 });
    
    // 3. Company transaction reports (analytics and reporting)
    TransactionSchema.index({ company: 1, date: -1, status: 1 });
    
    // 4. Status filtering (for pending/completed transactions)
    TransactionSchema.index({ status: 1, date: -1 });
    
    // 5. Currency-based queries (for currency reports)
    TransactionSchema.index({ company: 1, currency: 1, date: -1 });
    
    // 6. Type-based queries (for transaction type analytics)
    TransactionSchema.index({ company: 1, type: 1, date: -1 });
    
    // 7. Finance record queries (for balance reconciliation)
    TransactionSchema.index({ senderFinance: 1, date: -1 });
    TransactionSchema.index({ receiverFinance: 1, date: -1 });
    
    // 8. Related transaction lookup (for bet/payout linking)
    TransactionSchema.index({ relatedTransactionId: 1 });
}

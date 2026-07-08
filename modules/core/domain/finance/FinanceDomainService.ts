// /**
//  * Finance Domain Service
//  *
//  * Provides atomic financial operations for the casino backend.
//  * All operations use MongoDB atomic operations to prevent race conditions.
//  *
//  * CRITICAL: This service handles real money - all operations must be atomic and correct.
//  */
//
// import {ClientSession, ObjectId, Decimal128} from "mongodb";
// import Finance, {FinanceCurrencies, IFinance} from "@coreModule/database/schemas/finance/finance";
// import Transaction, {ITransaction, TransactionStatus, TransactionType} from "@coreModule/database/schemas/transaction/transaction";
// import {serverLogger} from "@coreModule/loggers/serverLog";
// import {BalanceResult, TransferRequest, TransactionRequest} from "./types";
// import {getRedisClient, isRedisConnected} from "@coreModule/connections/connectToRedis";
// import AuditLog, {AuditAction} from "@coreModule/database/schemas/auditLog/auditLog";
// import {emitNotificationEvent, NotificationEventCodes} from "@coreModule/domain/notifications/notificationEventBus";
//
// function notificationUserId(ref: unknown): string {
//     if (ref && typeof ref === "object" && "_id" in (ref as object)) {
//         return String((ref as {_id: ObjectId})._id);
//     }
//     return String(ref);
// }
//
// function notificationCompanyId(ref: unknown): string {
//     return notificationUserId(ref);
// }
//
// export class FinanceDomainService {
//     /**
//      * Atomically deduct amount from user's balance
//      * Uses findOneAndUpdate with condition to prevent overdraft
//      *
//      * @param financeId - Finance record ID
//      * @param currencyId - Currency ID
//      * @param amount - Amount to deduct (must be positive)
//      * @param session - MongoDB session for transaction
//      * @param logger - Optional logger
//      * @returns Result with success status and new balance
//      */
//     async deductBalance(
//         financeId: ObjectId,
//         currencyId: ObjectId,
//         amount: Decimal128,
//         session: ClientSession,
//         logger?: serverLogger
//     ): Promise<BalanceResult> {
//         if (logger) {
//             logger.debug(`Deducting ${amount.toString()} from finance ${financeId.toString()} for currency ${currencyId.toString()}`);
//         }
//
//         // Convert amount to negative for $inc operation
//         const negativeAmount = Decimal128.fromString(`-${amount.toString()}`);
//
//         // Use findOneAndUpdate with condition to ensure sufficient balance
//         const result = await Finance.findOneAndUpdate(
//             {
//                 _id: financeId,
//                 "currencies.currency": currencyId,
//                 $expr: {
//                     $gte: [
//                         {
//                             $let: {
//                                 vars: {
//                                     currencyIndex: {
//                                         $indexOfArray: ["$currencies.currency", currencyId]
//                                     }
//                                 },
//                                 in: {
//                                     $arrayElemAt: [
//                                         "$currencies.amount",
//                                         "$$currencyIndex"
//                                     ]
//                                 }
//                             }
//                         },
//                         amount
//                     ]
//                 }
//             },
//             {
//                 $inc: {
//                     "currencies.$[elem].amount": negativeAmount
//                 }
//             },
//             {
//                 session,
//                 arrayFilters: [{ "elem.currency": currencyId }],
//                 new: true
//             }
//         );
//
//         if (!result) {
//             if (logger) {
//                 logger.warn(`Insufficient balance for finance ${financeId.toString()}, currency ${currencyId.toString()}`);
//             }
//             return {
//                 success: false,
//                 newBalance: Decimal128.fromString("0"),
//                 reason: "insufficient_balance"
//             };
//         }
//
//         const currencyEntry = result.currencies.find(
//             (c) => (c.currency as ObjectId).toString() === currencyId.toString()
//         );
//
//         if (!currencyEntry) {
//             throw new Error(`Currency entry not found after update`);
//         }
//
//         // Invalidate cache
//         await this.invalidateBalanceCache(financeId, currencyId);
//
//         return {
//             success: true,
//             newBalance: currencyEntry.amount
//         };
//     }
//
//     /**
//      * Atomically add amount to user's balance
//      *
//      * @param financeId - Finance record ID
//      * @param currencyId - Currency ID
//      * @param amount - Amount to add (must be positive)
//      * @param session - MongoDB session for transaction
//      * @param logger - Optional logger
//      * @returns New balance after addition
//      */
//     async addBalance(
//         financeId: ObjectId,
//         currencyId: ObjectId,
//         amount: Decimal128,
//         session: ClientSession,
//         logger?: serverLogger
//     ): Promise<Decimal128> {
//         if (logger) {
//             logger.debug(`Adding ${amount.toString()} to finance ${financeId.toString()} for currency ${currencyId.toString()}`);
//         }
//
//         const result = await Finance.findOneAndUpdate(
//             {
//                 _id: financeId,
//                 "currencies.currency": currencyId
//             },
//             {
//                 $inc: {
//                     "currencies.$[elem].amount": amount
//                 }
//             },
//             {
//                 session,
//                 arrayFilters: [{ "elem.currency": currencyId }],
//                 new: true
//             }
//         );
//
//         if (!result) {
//             // If currency entry doesn't exist, create it
//             const finance = await Finance.findById(financeId).session(session);
//             if (!finance) {
//                 throw new Error("Finance record not found");
//             }
//
//             // Add new currency entry
//             await Finance.findByIdAndUpdate(
//                 financeId,
//                 {
//                     $push: {
//                         currencies: {
//                             currency: currencyId,
//                             amount: amount
//                         }
//                     }
//                 },
//                 { session }
//             );
//
//             // Invalidate cache
//             await this.invalidateBalanceCache(financeId, currencyId);
//
//             return amount;
//         }
//
//         const currencyEntry = result.currencies.find(
//             (c) => (c.currency as ObjectId).toString() === currencyId.toString()
//         );
//
//         if (!currencyEntry) {
//             throw new Error(`Currency entry not found after update`);
//         }
//
//         // Invalidate cache
//         await this.invalidateBalanceCache(financeId, currencyId);
//
//         return currencyEntry.amount;
//     }
//
//     /**
//      * Transfer amount between two finance records atomically
//      * This is the CORE operation for a casino backend
//      *
//      * @param request - Transfer request parameters
//      * @param session - MongoDB session for transaction
//      * @param logger - Optional logger
//      * @param auditContext - Optional audit context (IP, idempotency key, etc.)
//      * @returns Created transaction record
//      */
//     async transfer(
//         request: TransferRequest,
//         session: ClientSession,
//         logger?: serverLogger,
//         auditContext?: {
//             ipAddress?: string;
//             idempotencyKey?: string;
//             userAgent?: string;
//         }
//     ): Promise<ITransaction> {
//         const {
//             fromFinanceId,
//             toFinanceId,
//             currencyId,
//             amount,
//             transactionType,
//             companyId,
//             senderUserId,
//             receiverUserId,
//             relatedTransactionId
//         } = request;
//
//         if (logger) {
//             logger.debug(`Transferring ${amount.toString()} from finance ${fromFinanceId.toString()} to ${toFinanceId.toString()}`);
//         }
//
//         // Step 1: Deduct from sender (with balance check)
//         const deductResult = await this.deductBalance(
//             fromFinanceId,
//             currencyId,
//             amount,
//             session,
//             logger
//         );
//
//         if (!deductResult.success) {
//             throw new Error(`Insufficient balance: ${deductResult.reason}`);
//         }
//
//         // Step 2: Add to receiver
//         await this.addBalance(
//             toFinanceId,
//             currencyId,
//             amount,
//             session,
//             logger
//         );
//
//         // Step 3: Create transaction record
//         const transaction = await Transaction.create([{
//             amount,
//             currency: currencyId,
//             sender: senderUserId,
//             receiver: receiverUserId,
//             senderFinance: fromFinanceId,
//             receiverFinance: toFinanceId,
//             date: new Date(),
//             status: TransactionStatus.COMPLETED,
//             type: transactionType,
//             company: companyId,
//             relatedTransactionId: relatedTransactionId
//         }], { session });
//
//         // Step 4: Create enhanced audit log for financial operation
//         await this.createFinancialAuditLog(
//             transaction[0]._id,
//             'Transaction',
//             companyId,
//             senderUserId,
//             {
//                 action: 'CREATE',
//                 transactionType,
//                 amount: amount.toString(),
//                 currencyId: currencyId.toString(),
//                 fromFinanceId: fromFinanceId.toString(),
//                 toFinanceId: toFinanceId.toString(),
//                 senderUserId: senderUserId.toString(),
//                 receiverUserId: receiverUserId.toString(),
//                 transactionId: transaction[0]._id.toString(),
//                 status: TransactionStatus.COMPLETED,
//                 ipAddress: auditContext?.ipAddress,
//                 idempotencyKey: auditContext?.idempotencyKey,
//                 userAgent: auditContext?.userAgent
//             },
//             session
//         );
//
//         // Record metrics
//         const duration = Date.now() - (logger ? (logger as any).startTime || Date.now() : Date.now());
//         financeMetrics.recordTransactionLatency('transfer', duration, 'success');
//
//         if (logger) {
//             logger.debug(`Transaction ${transaction[0]._id.toString()} created successfully`);
//         }
//
//         this.emitTransactionCompletedNotifications(transaction[0], session);
//
//         return transaction[0];
//     }
//
//     /**
//      * Create enhanced audit log for financial operations
//      *
//      * @param documentId - Document ID (transaction ID)
//      * @param collectionName - Collection name
//      * @param companyId - Company ID
//      * @param actorId - User ID performing the action
//      * @param context - Additional context (amount, currency, IP, etc.)
//      * @param session - MongoDB session
//      */
//     private async createFinancialAuditLog(
//         documentId: ObjectId,
//         collectionName: string,
//         companyId: ObjectId,
//         actorId: ObjectId,
//         context: {
//             action: string;
//             transactionType?: string;
//             amount?: string;
//             currencyId?: string;
//             fromFinanceId?: string;
//             toFinanceId?: string;
//             senderUserId?: string;
//             receiverUserId?: string;
//             transactionId?: string;
//             status?: string;
//             ipAddress?: string;
//             idempotencyKey?: string;
//             userAgent?: string;
//         },
//         session: ClientSession
//     ): Promise<void> {
//         try {
//             await AuditLog.create([{
//                 documentId,
//                 collectionName,
//                 organizationId: companyId,
//                 actorId,
//                 action: context.action as AuditAction,
//                 diff: {
//                     ...context,
//                     timestamp: new Date().toISOString()
//                 }
//             }], { session });
//         } catch (error) {
//             // Log error but don't fail the transaction
//             // Audit logging should not block financial operations
//             if (logger) {
//                 logger.warn?.(
//                     `Failed to create audit log for financial operation`,
//                     { error: (error as Error).message, documentId: documentId.toString() }
//                 );
//             }
//         }
//     }
//
//     /**
//      * Create a transaction (for deposits, withdrawals, bets, payouts)
//      *
//      * @param request - Transaction request parameters
//      * @param session - MongoDB session for transaction
//      * @param logger - Optional logger
//      * @param auditContext - Optional audit context (IP, idempotency key, etc.)
//      * @returns Created transaction record
//      */
//     async createTransaction(
//         request: TransactionRequest,
//         session: ClientSession,
//         logger?: serverLogger,
//         auditContext?: {
//             ipAddress?: string;
//             idempotencyKey?: string;
//             userAgent?: string;
//         }
//     ): Promise<ITransaction> {
//         const {
//             financeId,
//             currencyId,
//             amount,
//             transactionType,
//             companyId,
//             userId,
//             relatedUserId,
//             relatedTransactionId
//         } = request;
//
//         if (logger) {
//             logger.debug(`Creating ${transactionType} transaction for finance ${financeId.toString()}`);
//         }
//
//         // Determine if this is a credit or debit transaction
//         const isCredit = [TransactionType.DEPOSIT, TransactionType.WIN, TransactionType.BONUS, TransactionType.REFUND].includes(transactionType);
//         const isDebit = [TransactionType.WITHDRAWAL, TransactionType.BET, TransactionType.LOSS].includes(transactionType);
//
//         let newBalance: Decimal128;
//
//         if (isCredit) {
//             // Add to balance
//             newBalance = await this.addBalance(financeId, currencyId, amount, session, logger);
//         } else if (isDebit) {
//             // Deduct from balance
//             const result = await this.deductBalance(financeId, currencyId, amount, session, logger);
//             if (!result.success) {
//                 throw new Error(`Insufficient balance: ${result.reason}`);
//             }
//             newBalance = result.newBalance;
//         } else {
//             throw new Error(`Invalid transaction type for createTransaction: ${transactionType}`);
//         }
//
//         // Create transaction record
//         const transaction = await Transaction.create([{
//             amount,
//             currency: currencyId,
//             sender: isDebit ? userId : (relatedUserId || userId),
//             receiver: isCredit ? userId : (relatedUserId || userId),
//             senderFinance: isDebit ? financeId : undefined,
//             receiverFinance: isCredit ? financeId : undefined,
//             date: new Date(),
//             status: TransactionStatus.COMPLETED,
//             type: transactionType,
//             company: companyId,
//             relatedTransactionId: relatedTransactionId
//         }], { session });
//
//         // Create enhanced audit log for financial operation
//         await this.createFinancialAuditLog(
//             transaction[0]._id,
//             'Transaction',
//             companyId,
//             userId,
//             {
//                 action: 'CREATE',
//                 transactionType,
//                 amount: amount.toString(),
//                 currencyId: currencyId.toString(),
//                 financeId: financeId.toString(),
//                 userId: userId.toString(),
//                 relatedUserId: relatedUserId?.toString(),
//                 transactionId: transaction[0]._id.toString(),
//                 status: TransactionStatus.COMPLETED,
//                 newBalance: newBalance.toString(),
//                 ipAddress: auditContext?.ipAddress,
//                 idempotencyKey: auditContext?.idempotencyKey,
//                 userAgent: auditContext?.userAgent
//             },
//             session
//         );
//
//         if (logger) {
//             logger.debug(`Transaction ${transaction[0]._id.toString()} created with new balance ${newBalance.toString()}`);
//         }
//
//         this.emitTransactionCompletedNotifications(transaction[0], session);
//
//         return transaction[0];
//     }
//
//     private emitTransactionCompletedNotifications(doc: ITransaction, session: ClientSession, languageCode: string = "en-US"): void {
//         const companyId = notificationCompanyId(doc.company);
//         const transactionId = doc._id.toString();
//         const amount = doc.amount.toString();
//         const currencyId = notificationUserId(doc.currency);
//         const transactionType = doc.type;
//         const senderId = notificationUserId(doc.sender);
//         const receiverId = notificationUserId(doc.receiver);
//
//         const basePayload = {
//             companyId,
//             transactionId,
//             amount,
//             currencyId,
//             transactionType,
//             languageCode
//         };
//
//         if (senderId === receiverId) {
//             emitNotificationEvent(NotificationEventCodes.TRANSACTION_COMPLETED, {
//                 receiverIds: [receiverId],
//                 payload: {...basePayload, perspective: "receiver"},
//                 session
//             });
//             return;
//         }
//
//         emitNotificationEvent(NotificationEventCodes.TRANSACTION_COMPLETED, {
//             receiverIds: [receiverId],
//             payload: {...basePayload, perspective: "receiver"},
//             session
//         });
//         emitNotificationEvent(NotificationEventCodes.TRANSACTION_COMPLETED, {
//             receiverIds: [senderId],
//             payload: {...basePayload, perspective: "sender"},
//             session
//         });
//     }
//
//     /**
//      * Get current balance for a currency
//      * Uses Redis cache for performance
//      *
//      * @param financeId - Finance record ID
//      * @param currencyId - Currency ID
//      * @param session - Optional MongoDB session
//      * @returns Current balance
//      */
//     async getBalance(
//         financeId: ObjectId,
//         currencyId: ObjectId,
//         session?: ClientSession
//     ): Promise<Decimal128> {
//         // Try cache first
//         const cacheKey = `balance:${financeId.toString()}:${currencyId.toString()}`;
//         const startTime = Date.now();
//
//         if (isRedisConnected()) {
//             try {
//                 const cached = await getRedisClient().get(cacheKey);
//                 if (cached) {
//                     const duration = Date.now() - startTime;
//                     financeMetrics.recordBalanceQueryLatency(duration, true);
//                     financeMetrics.recordCacheOperation('hit');
//                     return Decimal128.fromString(cached);
//                 }
//                 financeMetrics.recordCacheOperation('miss');
//             } catch (error) {
//                 // Cache miss or error - continue to database
//                 financeMetrics.recordCacheOperation('miss');
//             }
//         }
//
//         // Fetch from database
//         const finance = await Finance.findById(financeId).session(session || null);
//         if (!finance) {
//             throw new Error("Finance record not found");
//         }
//
//         const currencyEntry = finance.currencies.find(
//             (c: any) => c.currency.toString() === currencyId.toString()
//         );
//
//         if (!currencyEntry) {
//             const balance = Decimal128.fromString("0");
//             // Cache the zero balance (5 minutes TTL for high-frequency reads)
//             if (isRedisConnected()) {
//                 try {
//                     await getRedisClient().setEx(cacheKey, 300, balance.toString());
//                 } catch (error) {
//                     // Ignore cache errors
//                 }
//             }
//             return balance;
//         }
//
//         // Cache the balance (5 minutes TTL for high-frequency reads)
//         if (isRedisConnected()) {
//             try {
//                 await getRedisClient().setEx(cacheKey, 300, currencyEntry.amount.toString());
//             } catch (error) {
//                 // Ignore cache errors
//             }
//         }
//
//         // Record metrics
//         const duration = Date.now() - startTime;
//         financeMetrics.recordBalanceQueryLatency(duration, false);
//
//         return currencyEntry.amount;
//     }
//
//     /**
//      * Get balances for multiple currencies in a single query
//      * Reduces N+1 query problem when fetching multiple balances
//      *
//      * @param financeId - Finance record ID
//      * @param currencyIds - Array of currency IDs to fetch balances for
//      * @param session - Optional MongoDB session
//      * @returns Map of currencyId to balance (Decimal128)
//      */
//     async getBalances(
//         financeId: ObjectId,
//         currencyIds: ObjectId[],
//         session?: ClientSession
//     ): Promise<Map<ObjectId, Decimal128>> {
//         const result = new Map<ObjectId, Decimal128>();
//
//         if (currencyIds.length === 0) {
//             return result;
//         }
//
//         // Try cache first for all currencies
//         const cacheKeys: string[] = [];
//         const cacheKeyMap = new Map<string, ObjectId>();
//         const uncachedCurrencyIds: ObjectId[] = [];
//
//         if (isRedisConnected()) {
//             for (const currencyId of currencyIds) {
//                 const cacheKey = `balance:${financeId.toString()}:${currencyId.toString()}`;
//                 cacheKeys.push(cacheKey);
//                 cacheKeyMap.set(cacheKey, currencyId);
//             }
//
//             try {
//                 // Batch get from cache
//                 const cachedValues = await getRedisClient().mGet(cacheKeys);
//                 for (let i = 0; i < cachedValues.length; i++) {
//                     const cached = cachedValues[i];
//                     const currencyId = cacheKeyMap.get(cacheKeys[i]);
//                     if (cached && currencyId) {
//                         result.set(currencyId, Decimal128.fromString(cached));
//                     } else if (currencyId) {
//                         uncachedCurrencyIds.push(currencyId);
//                     }
//                 }
//             } catch (error) {
//                 // Cache error - fetch all from database
//                 uncachedCurrencyIds.push(...currencyIds);
//             }
//         } else {
//             uncachedCurrencyIds.push(...currencyIds);
//         }
//
//         // Fetch uncached balances from database in single query
//         if (uncachedCurrencyIds.length > 0) {
//             const finance = await Finance.findById(financeId).session(session || null);
//             if (!finance) {
//                 throw new Error("Finance record not found");
//             }
//
//             // Filter currencies that match requested IDs
//             const currencyIdStrings = new Set(uncachedCurrencyIds.map(id => id.toString()));
//             const currencyEntries = finance.currencies.filter(
//                 (c) => currencyIdStrings.has((c.currency as ObjectId).toString())
//             );
//
//             // Cache and add to result
//             for (const entry of currencyEntries) {
//                 const currencyId = entry.currency instanceof ObjectId
//                     ? entry.currency
//                     : new ObjectId(entry.currency.toString());
//                 const balance = entry.amount;
//                 result.set(currencyId, balance);
//
//                 // Cache the balance
//                 if (isRedisConnected()) {
//                     try {
//                         const cacheKey = `balance:${financeId.toString()}:${currencyId.toString()}`;
//                         await getRedisClient().setEx(cacheKey, 300, balance.toString());
//                     } catch (error) {
//                         // Ignore cache errors
//                     }
//                 }
//             }
//
//             // Set zero balance for currencies not found
//             for (const currencyId of uncachedCurrencyIds) {
//                 if (!result.has(currencyId)) {
//                     const zeroBalance = Decimal128.fromString("0");
//                     result.set(currencyId, zeroBalance);
//
//                     // Cache zero balance
//                     if (isRedisConnected()) {
//                         try {
//                             const cacheKey = `balance:${financeId.toString()}:${currencyId.toString()}`;
//                             await getRedisClient().setEx(cacheKey, 300, zeroBalance.toString());
//                         } catch (error) {
//                             // Ignore cache errors
//                         }
//                     }
//                 }
//             }
//         }
//
//         return result;
//     }
//
//     /**
//      * Invalidate balance cache
//      *
//      * @param financeId - Finance record ID
//      * @param currencyId - Currency ID
//      */
//     private async invalidateBalanceCache(
//         financeId: ObjectId,
//         currencyId: ObjectId
//     ): Promise<void> {
//         if (!isRedisConnected()) {
//             return;
//         }
//
//         try {
//             const cacheKey = `balance:${financeId.toString()}:${currencyId.toString()}`;
//             await getRedisClient().del(cacheKey);
//         } catch (error) {
//             // Ignore cache errors
//         }
//     }
//
//     /**
//      * Check idempotency key
//      *
//      * @param key - Idempotency key
//      * @returns Cached result if exists, null otherwise
//      */
//     async checkIdempotency(key: string): Promise<unknown | null> {
//         if (!isRedisConnected()) {
//             return null;
//         }
//
//         try {
//             const cached = await getRedisClient().get(`idempotency:${key}`);
//             if (cached) {
//                 return JSON.parse(cached);
//             }
//         } catch (error) {
//             // Ignore cache errors
//         }
//
//         return null;
//     }
//
//     /**
//      * Store idempotency result
//      *
//      * @param key - Idempotency key
//      * @param result - Result to cache
//      * @param ttl - Time to live in seconds (default: 3600 = 1 hour)
//      */
//     async storeIdempotency(key: string, result: unknown, ttl: number = 3600): Promise<void> {
//         if (!isRedisConnected()) {
//             return;
//         }
//
//         try {
//             await getRedisClient().setEx(
//                 `idempotency:${key}`,
//                 ttl,
//                 JSON.stringify(result)
//             );
//         } catch (error) {
//             // Ignore cache errors
//         }
//     }
//
//     /**
//      * Reconcile balance from transaction history
//      * Useful for audit and verification
//      *
//      * Optimized to use indexes efficiently by running two parallel aggregations:
//      * - One for transactions where financeId is the sender (deducts from balance)
//      * - One for transactions where financeId is the receiver (adds to balance)
//      *
//      * This approach allows MongoDB to use the senderFinance and receiverFinance indexes
//      * separately, which is more efficient than using $or in a single query.
//      *
//      * @param financeId - Finance record ID
//      * @param currencyId - Currency ID
//      * @param session - Optional MongoDB session
//      * @returns Calculated balance from transactions
//      */
//     async reconcileBalance(
//         financeId: ObjectId,
//         currencyId: ObjectId,
//         session?: ClientSession
//     ): Promise<Decimal128> {
//         // Use $facet to run both queries in parallel for better performance
//         // This allows MongoDB to use senderFinance and receiverFinance indexes separately
//         const basePipeline = [
//             {
//                 $facet: {
//                     // Transactions where financeId is the sender (deducts from balance)
//                     sent: [
//                         {
//                             $match: {
//                                 senderFinance: financeId,
//                                 currency: currencyId,
//                                 status: TransactionStatus.COMPLETED
//                             }
//                         },
//                         {
//                             $group: {
//                                 _id: null,
//                                 total: { $sum: "$amount" }
//                             }
//                         }
//                     ],
//                     // Transactions where financeId is the receiver (adds to balance)
//                     received: [
//                         {
//                             $match: {
//                                 receiverFinance: financeId,
//                                 currency: currencyId,
//                                 status: TransactionStatus.COMPLETED
//                             }
//                         },
//                         {
//                             $group: {
//                                 _id: null,
//                                 total: { $sum: "$amount" }
//                             }
//                         }
//                     ]
//                 }
//             },
//             // Combine results: received - sent = balance
//             {
//                 $project: {
//                     balance: {
//                         $subtract: [
//                             { $ifNull: [{ $arrayElemAt: ["$received.total", 0] }, Decimal128.fromString("0")] },
//                             { $ifNull: [{ $arrayElemAt: ["$sent.total", 0] }, Decimal128.fromString("0")] }
//                         ]
//                     }
//                 }
//             }
//         ];
//
//         let aggregation = Transaction.aggregate(basePipeline);
//
//         if (session) {
//             aggregation = aggregation.session(session);
//         }
//
//         const result = await aggregation.exec();
//         const balance = result[0]?.balance;
//
//         // Handle Decimal128 conversion if needed
//         if (balance instanceof Decimal128) {
//             return balance;
//         } else if (typeof balance === 'number') {
//             return Decimal128.fromString(balance.toString());
//         } else {
//             return Decimal128.fromString("0");
//         }
//     }
// }
//
// export const financeDomainService = new FinanceDomainService();
//

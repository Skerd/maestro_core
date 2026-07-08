/**
 * Transaction Service
 * 
 * CRUD service for Transaction model.
 */

import {BaseCrudService} from '@coreModule/database/services/baseCrudService';
import Transaction, {ITransaction} from '@coreModule/database/schemas/transaction/transaction';

export class TransactionService extends BaseCrudService<ITransaction, typeof Transaction> {
    constructor() {
        super(Transaction, 'Transaction');
    }
}

export const transactionService = new TransactionService();


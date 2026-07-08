/**
 * Finance Service
 * 
 * CRUD service for Finance model with domain-specific methods.
 */

import {BaseCrudService, CrudOptions} from '@coreModule/database/services/baseCrudService';
import Finance, {IFinance} from '@coreModule/database/schemas/finance/finance';
import {Decimal128, ObjectId} from 'mongodb';

export class FinanceService extends BaseCrudService<IFinance, typeof Finance> {
    constructor() {
        super(Finance, 'Finance');
    }

    /**
     * Find finance record for a user and company
     * 
     * @param userId - User ID
     * @param companyId - Company ID
     * @param options - CRUD options
     * @returns Finance record or null
     */
    async findFinanceForCompany(
        userId: ObjectId,
        companyId: ObjectId,
        options: CrudOptions = {}
    ): Promise<IFinance | null> {
        // This requires the user to be loaded with finance populated
        // The actual lookup should be done at the endpoint level
        // This method is a convenience wrapper
        return await this.findOne(
            { company: companyId },
            options,
            "currencies.currency"
        );
    }

    /**
     * Get balance for a specific currency
     * 
     * @param financeId - Finance record ID
     * @param currencyId - Currency ID
     * @param options - CRUD options
     * @returns Balance as Decimal128
     */
    async getBalanceForCurrency(
        financeId: ObjectId,
        currencyId: ObjectId,
        options: CrudOptions = {}
    ): Promise<Decimal128> {
        const finance = await this.findById(
            financeId,
            options,
            "currencies.currency"
        );

        if (!finance) {
            return Decimal128.fromString("0");
        }

        const currencyEntry = finance.currencies.find(
            (c: any) => c.currency.toString() === currencyId.toString()
        );

        if (!currencyEntry) {
            return Decimal128.fromString("0");
        }

        return currencyEntry.amount;
    }
}

export const financeService = new FinanceService();


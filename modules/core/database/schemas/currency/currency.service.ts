import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import Currency, {ICurrency} from "@coreModule/database/schemas/currency/currency";

export class CurrencyService extends BaseCrudService<ICurrency, typeof Currency> {
    constructor() {
        super(Currency, "Currency");
    }
}

export const currencyService = new CurrencyService();

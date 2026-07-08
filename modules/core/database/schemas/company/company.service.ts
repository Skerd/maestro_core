/**
 * Company Service
 * 
 * CRUD service for Company model.
 */

import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import Company, {ICompany} from "./company";

export class CompanyService extends BaseCrudService<ICompany, typeof Company> {
    constructor() {
        super(Company, 'Company');
    }
}

export const companyService = new CompanyService();


import {Schema} from "mongoose";

export function applyCompanyIndexes(CompanySchema: Schema): void {
    CompanySchema.index({company: 1, createdAt: -1});
    CompanySchema.index({createdAt: -1});
    // Primary field indexes
    CompanySchema.index({name: 1});
    CompanySchema.index({email: 1});
    CompanySchema.index({vat: 1});
    CompanySchema.index({phoneNumber: 1});
    CompanySchema.index({parentCompany: 1});
    CompanySchema.index({isActive: 1});
    CompanySchema.index({isDefaultForSignUp: 1});
    CompanySchema.index({"addresses.city": 1});
    CompanySchema.index({"addresses.country": 1});
    CompanySchema.index({allowedDomains: 1});
    CompanySchema.index({isActive: 1, isDefaultForSignUp: 1});
    CompanySchema.index({parentCompany: 1, isActive: 1});
    CompanySchema.index({name: 1, isActive: 1});
    CompanySchema.index({vat: 1, isActive: 1});
}

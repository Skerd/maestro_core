import {Schema} from "mongoose";

export function applyCompanyIndexes(CompanySchema: Schema): void {
    CompanySchema.index({company: 1, createdAt: -1});
    CompanySchema.index({createdAt: -1});
    // Primary field indexes
    CompanySchema.index({name: 1});
    CompanySchema.index({email: 1});
    // Unique only when filled (D178): a self-serve company may start without one. Databases made before D178 hold a
    // plain unique `vat_1` that must be dropped once for this one to build (no migration, GLB-06).
    CompanySchema.index({vat: 1}, {unique: true, partialFilterExpression: {vat: {$gt: ""}}});
    CompanySchema.index({phoneNumber: 1});
    CompanySchema.index({parentCompany: 1});
    CompanySchema.index({isActive: 1});
    CompanySchema.index({isDefaultForSignUp: 1});
    CompanySchema.index({isPlatformOwner: 1}, {unique: true, partialFilterExpression: {isPlatformOwner: true}});
    CompanySchema.index({modules: 1});
    CompanySchema.index({"addresses.city": 1});
    CompanySchema.index({"addresses.country": 1});
    CompanySchema.index({allowedDomains: 1});
    CompanySchema.index({siteSlug: 1}, {unique: true, sparse: true});
    CompanySchema.index({siteHost: 1}, {sparse: true});
    CompanySchema.index({isActive: 1, isDefaultForSignUp: 1});
    CompanySchema.index({parentCompany: 1, isActive: 1});
    // One sample company per real company at a time (D178, P23.4); the route checks first, this catches a race.
    CompanySchema.index({parentCompany: 1, isSandbox: 1}, {unique: true, partialFilterExpression: {isSandbox: true}});
    CompanySchema.index({name: 1, isActive: 1});
    CompanySchema.index({vat: 1, isActive: 1});
}

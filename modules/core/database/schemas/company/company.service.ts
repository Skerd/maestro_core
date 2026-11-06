/**
 * Company Service
 * 
 * CRUD service for Company model.
 */

import type {FilterQuery} from "mongoose";
import type {ObjectId} from "mongodb";
import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import Company, {ICompany} from "./company";

export class CompanyService extends BaseCrudService<ICompany, typeof Company> {
    constructor() {
        super(Company, 'Company');
    }

    /** Every company's id and module grants (cron seeding works per company). */
    async findModuleGrants() {
        return this.model.find({}).select("_id modules").lean();
    }

    /** Ids of the companies matching `filter`, deleted ones excluded. */
    async findIds(filter: FilterQuery<ICompany>): Promise<ObjectId[]> {
        const rows = await this.model.find(filter, {_id: 1}).noDeleted().lean<{_id: ObjectId}[]>();
        return rows.map((row) => row._id);
    }

    /** What a portal company card shows, sorted by name. */
    async findPortalCards(companyIds: ObjectId[]) {
        return this.model.find({_id: {$in: companyIds}})
            .select("_id name siteSlug logo description")
            .sort({name: 1})
            .lean<{_id: ObjectId; name: string; siteSlug?: string; logo?: ObjectId; description?: string}[]>();
    }

    /** Name and site slug per company, for labelling portal search hits. */
    async findPortalRefs(companyIds: ObjectId[]) {
        return this.model.find({_id: {$in: companyIds}}).select("_id name siteSlug").lean<{_id: ObjectId; name: string; siteSlug?: string}[]>();
    }

    /** The companies' own addresses with their city names. */
    async findAddressCities(companyIds: ObjectId[]) {
        return this.model.find({_id: {$in: companyIds}})
            .select("_id addresses.city")
            .populate({path: "addresses.city", select: "name"})
            .lean<{_id: ObjectId; addresses?: {city?: {name?: string}}[]}[]>();
    }
}

export const companyService = new CompanyService();


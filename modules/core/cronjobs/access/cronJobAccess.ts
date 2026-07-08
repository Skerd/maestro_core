import {ObjectId} from "mongodb";
import type {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";

export async function buildCronJobListFilter(
    params: AuthenticatedMWType,
): Promise<Record<string, unknown>> {
    const {company, actionUserCtx} = params;
    const isAdmin = await actionUserCtx.isAdmin(company._id);
    if (isAdmin) {
        return {
            $or: [{company: company._id}, {company: null}],
        };
    }
    return {company: company._id, scope: "company"};
}

export async function buildCronJobIdFilter(
    jobId: string,
    params: AuthenticatedMWType,
): Promise<Record<string, unknown>> {
    const base = await buildCronJobListFilter(params);
    return {...base, _id: new ObjectId(jobId)};
}

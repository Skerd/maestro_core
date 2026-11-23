import mongoose, {type ClientSession} from "mongoose";
import {ObjectId, type Db} from "mongodb";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {slugifySiteSlug} from "armonia/src/modules/core/api/company/private/company/siteSlug";
import type {SandboxCompany, SandboxSeedStatus} from "armonia/src/modules/core/api/company/private/sandbox/sandbox.dto";
import Company, {type ICompany} from "@coreModule/database/schemas/company/company";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {lastChannelReadMessageService} from "@coreModule/database/schemas/lastChannelReadMessage/lastChannelReadMessage.service";
import Channel from "@coreModule/database/schemas/channel/channel";
import LastChannelReadMessage from "@coreModule/database/schemas/lastChannelReadMessage/lastChannelReadMessage";
import Media from "@coreModule/database/schemas/media/media";
import {isTenantOwned} from "@coreModule/database/plugins/tenantReferences";
import {getLogger, type serverLogger} from "@coreModule/loggers/serverLog";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {runAfterCommit} from "@coreModule/utilities/middlewares/transactionUtils";
import {effectiveCompanyModules, invalidateCompanyModules} from "@coreModule/utilities/modules/companyModules";
import {runModuleCompanyDemoSeeds} from "@coreModule/utilities/modules/runModuleCompanyDemoSeeds";
import {getGridFSStorage} from "@coreModule/utilities/gridfs/gridfsStorage";
import {invalidateCompanyMailCache} from "@coreModule/utilities/emails/mailDeliveryService";
import {createCompany, type CreateCompanyContext} from "@coreModule/domain/company/createCompany";

/**
 * "Try with sample data" (D178, P23.4). A company's admin makes a separate sample company owned by them, with the same
 * modules, filled in the background by the modules' demo seeders (`runModuleCompanyDemoSeeds`). It is never listed on
 * the portal (`portalCompanyClause`), sends no email or SMS (`isSandboxCompany` in the core send paths), lists no panel
 * host so a sign-in never lands in it (TD-B255), and is deleted in one click: every row it owns, its files and the
 * memberships people hold in it. Only a company marked `isSandbox` can be deleted this way.
 */

type WriteContext = {session: ClientSession; logger: serverLogger; languageCode: string};

/** How often a running seed says it is still alive. */
export const SANDBOX_SEED_HEARTBEAT_MS = 20 * 1000;
/**
 * A seed "preparing" with no sign of life for this long died with its server (a restart or deploy mid-seed); it then
 * reads as failed and may be deleted.
 */
export const SANDBOX_SEED_STALE_MS = 2 * 60 * 1000;

/** Where a sample company's demo data stands now: a seed that stopped without finishing counts as failed. */
export function sandboxSeedStatus(seed: ICompany["sandboxSeed"], now: Date = new Date()): SandboxSeedStatus {
    if (!seed) return "failed";
    const lastSign = seed.heartbeatAt ?? seed.startedAt;
    if (seed.status === "preparing" && now.getTime() - lastSign.getTime() > SANDBOX_SEED_STALE_MS) return "failed";
    return seed.status;
}

export function sandboxToDTO(company: Pick<ICompany, "_id" | "name" | "sandboxSeed">): SandboxCompany {
    return {
        _id: String(company._id),
        name: company.name,
        status: sandboxSeedStatus(company.sandboxSeed),
        startedAt: (company.sandboxSeed?.startedAt ?? new Date(0)).toISOString(),
        finishedAt: company.sandboxSeed?.finishedAt?.toISOString(),
    };
}

/** The sample company of `parentId`, if it has one (at most one, D178). */
export function findSandboxOf(parentId: ObjectId, ctx: {session?: ClientSession; logger?: serverLogger; languageCode?: string}) {
    return companyService.findOne({parentCompany: parentId, isSandbox: true}, ctx, undefined, "name sandboxSeed");
}

/** A site address for the sample company: the parent's own with "-sample", made unique if another company took it. */
async function sandboxSiteSlug(parent: Pick<ICompany, "name" | "siteSlug">, ctx: WriteContext): Promise<string> {
    const slug = slugifySiteSlug(`${parent.siteSlug || parent.name} sample`);
    const taken = await companyService.findOne({siteSlug: slug}, ctx, undefined, "_id");
    return taken ? slugifySiteSlug(`${slug} ${new ObjectId().toHexString().slice(-6)}`) : slug;
}

/**
 * Makes `parent`'s sample company, named `name`, with `parent`'s modules and the caller as its admin (the create
 * function's save hook), and starts its demo seed once the request's transaction has committed. The caller's trigger
 * checks who may do it and that `parent` has no sample company yet.
 */
export async function createSandboxCompany(
    parent: Pick<ICompany, "_id" | "name" | "siteSlug" | "timezone" | "modules">,
    name: string,
    ctx: CreateCompanyContext,
): Promise<ICompany> {
    const sandbox = await createCompany(
        {
            name,
            siteSlug: await sandboxSiteSlug(parent, ctx),
            // Its demo days fall in the business's own zone.
            timezone: parent.timezone,
            // No panel host (TD-B255): a sign-in never lands in a sample company; people switch to it.
            allowedDomains: [],
            parentCompanyId: parent._id,
            modules: effectiveCompanyModules(parent).filter((module) => module !== "core"),
            sandboxSeed: {status: "preparing", startedAt: new Date()},
        },
        ctx,
    );
    const companyId: ObjectId = sandbox._id;
    await runAfterCommit(ctx.session, async () => startSandboxSeed(companyId));
    return sandbox;
}

/** Starts the seed and returns at once: the seeders take minutes, so the request answers first and the panel polls. */
function startSandboxSeed(companyId: ObjectId): void {
    const logger = getLogger("sandbox_company_seed");
    seedSandboxCompany(companyId, logger).catch((error: unknown) => {
        logger.err(`Sample company ${companyId.toString()} seed crashed: ${error instanceof Error ? error.message : String(error)}`);
    });
}

/**
 * Fills a sample company with its modules' demo data and records the outcome on it. Runs on its own, outside the
 * request that made the company, in the sample company's tenant (D16): a seeder can neither read nor write another
 * company's records. A module whose seed fails is logged and skipped by the runner; the rest still lands.
 */
export async function seedSandboxCompany(companyId: ObjectId, parentLogger?: serverLogger): Promise<SandboxSeedStatus> {
    const logger = getLogger("sandbox_company_seed", parentLogger);
    // A fresh context: no request session or user, only the sample company as tenant.
    return requestContext.run({}, () => withTenant(companyId, async () => {
        let status: SandboxSeedStatus = "ready";
        // While this beats, the seed is alive; a server that stops mid-seed stops beating (`sandboxSeedStatus`).
        const heartbeat = setInterval(() => {
            companyService.updateOne({_id: companyId, isSandbox: true}, {$set: {"sandboxSeed.heartbeatAt": new Date()}}).catch(() => undefined);
        }, SANDBOX_SEED_HEARTBEAT_MS);
        try {
            const company = await companyService.findByIdOrThrow(companyId, {logger});
            logger.start(`Seeding sample company '${company.name}' (${companyId.toString()})...`);
            await runModuleCompanyDemoSeeds(logger, company);
        } catch (error) {
            status = "failed";
            logger.err(`Sample company ${companyId.toString()} seed failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            clearInterval(heartbeat);
        }
        await companyService.updateOne(
            {_id: companyId, isSandbox: true},
            {$set: {"sandboxSeed.status": status, "sandboxSeed.finishedAt": new Date()}},
            {logger},
        );
        logger.finish(`Sample company ${companyId.toString()} seed ${status}`);
        return status;
    }));
}

/**
 * Collections whose rows a company owns through `company` (DB-02): every collection in the database except those of a
 * registered model whose `company` names something else (a company's parent, a platform list's owner). A collection
 * with no registered model counts as a tenant's: some models load only on first use (the health data keys), and
 * `company` is the only tenant key (DB-02).
 */
async function tenantCollections(db: Db): Promise<string[]> {
    // Loaded here: the initializer imports the company defaults, which load this module's schemas. Registers every
    // enabled module's models, like the orphan upload sweep.
    const {getAllModels} = await import("@initializer");
    await getAllModels();
    const notTenant = new Set<string>([Company.collection.name]);
    for (const name of mongoose.modelNames()) {
        const model = mongoose.model(name);
        if (!isTenantOwned(model.schema)) notTenant.add(model.collection.name);
    }
    // Listed outside the transaction: a transaction cannot list collections.
    const collections = await db.listCollections({}, {nameOnly: true}).toArray();
    return collections.map(({name}) => name).filter((name) => !name.startsWith("system.") && !notTenant.has(name)).sort();
}

/** GridFS files of the sample company: its media's, and files its seeds uploaded without a record; none another company still uses. */
async function sandboxFileIds(db: Db, companyId: ObjectId, session: ClientSession): Promise<ObjectId[]> {
    const media = await Media.collection.find({company: companyId, fileId: {$ne: null}}, {projection: {fileId: 1}, session}).toArray();
    const uploads = await db.collection("media.files").find({"metadata.company": companyId.toString()}, {projection: {_id: 1}, session}).toArray();
    const ids = new Set([...media.map((row) => String(row.fileId)), ...uploads.map((row) => String(row._id))].filter((id) => ObjectId.isValid(id)));
    if (ids.size === 0) return [];
    const usedElsewhere = await Media.collection
        .find({fileId: {$in: [...ids].map((id) => new ObjectId(id))}, company: {$ne: companyId}}, {projection: {fileId: 1}, session})
        .toArray();
    for (const row of usedElsewhere) ids.delete(String(row.fileId));
    return [...ids].map((id) => new ObjectId(id));
}

export type SandboxDeleteResult = {
    /** Rows deleted per collection (only collections that had some). */
    rows: Record<string, number>;
    /** People whose membership in the sample company was removed. */
    memberships: number;
    files: number;
};

/**
 * Deletes a sample company for good: every row of every tenant collection whose `company` is it (soft-deleted rows too),
 * its chats' read markers, its bot, the memberships and invitations people hold in it, then the company itself, in the
 * caller's transaction; its GridFS files go after the commit. People's accounts stay (users are never deleted, D12/D73).
 *
 * Refuses anything not marked `isSandbox`, so a real company can never be deleted this way, and a sample company that
 * other companies hang under. The caller checks who may delete it and that its seed is not still running.
 */
export async function deleteSandboxCompany(sandboxId: ObjectId, ctx: WriteContext): Promise<SandboxDeleteResult> {
    const {session, logger, languageCode} = ctx;
    const sandbox = await companyService.findById(sandboxId, {session, logger, languageCode}, undefined, "name isSandbox");
    if (sandbox?.isSandbox !== true) {
        throw apiValidationException("company_not_sandbox", "", null, languageCode);
    }
    const children = await companyService.count({_id: {$ne: sandboxId}, $or: [{parentCompany: sandboxId}, {company: sandboxId}]}, {session, logger, languageCode, withDeleted: true});
    if (children > 0) {
        throw apiValidationException("company_sandbox_has_companies", "", null, languageCode);
    }

    const db = mongoose.connection.db;
    if (!db) throw new Error("Deleting a sample company needs the database connection");

    logger.start(`Deleting sample company '${sandbox.name}' (${sandboxId.toString()})...`);
    // Read before the rows that name them go.
    const fileIds = await sandboxFileIds(db, sandboxId, session);
    const channelIds = (await Channel.collection.find({company: sandboxId}, {projection: {_id: 1}, session}).toArray()).map((row) => row._id);

    const rows: Record<string, number> = {};
    // The collection driver, past the plugins: soft-deleted rows go too, and the filter names the sample company alone.
    for (const name of await tenantCollections(db)) {
        const {deletedCount} = await db.collection(name).deleteMany({company: sandboxId}, {session});
        if (deletedCount > 0) rows[name] = deletedCount;
    }
    if (channelIds.length > 0) {
        const {deletedCount} = await lastChannelReadMessageService.deleteMany({channel: {$in: channelIds}}, {session, logger});
        if (deletedCount > 0) rows[LastChannelReadMessage.collection.name] = deletedCount;
    }
    // Its bot is the sample company's own machine account, named after it: it goes with it, or a new sample company
    // of the same name could not make its own. People's accounts stay.
    const {deletedCount: bots} = await userService.deleteMany({isBot: true, companies: [sandboxId]}, {session, logger, hard: true});
    if (bots > 0) rows.users = bots;
    const {modifiedCount: memberships} = await userService.updateMany(
        {$or: [{companies: sandboxId}, {"roles.company": sandboxId}]},
        {$pull: {companies: sandboxId, roles: {company: sandboxId}}},
        {session, logger},
    );
    await userService.updateMany({"requests.invitation.company": sandboxId}, {$unset: {"requests.invitation": ""}}, {session, logger});
    await companyService.deleteOneOrThrow({_id: sandboxId, isSandbox: true}, {session, logger, languageCode, hard: true});

    await runAfterCommit(session, async () => {
        const gridfs = getGridFSStorage(languageCode, "media", logger);
        for (const fileId of fileIds) {
            try {
                await gridfs.deleteFile(fileId);
            } catch (error) {
                logger.warn(`Sample company file ${fileId.toHexString()} not deleted: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        invalidateCompanyMailCache(sandboxId);
        await invalidateCompanyModules(sandboxId);
    });
    logger.finish(`Deleted sample company '${sandbox.name}': ${Object.values(rows).reduce((sum, count) => sum + count, 0)} rows, ${memberships} memberships, ${fileIds.length} files`);
    return {rows, memberships, files: fileIds.length};
}

import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose, {Model, Schema, Types} from "mongoose";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";
import {COLUMN_TYPE} from "armonia/src/modules/core/database/filter/typeOperators";

/*
 * DB-01: what the plugin stack gives a schema, for the full stack and for each skip combination listed in
 * scripts/checks/plugin-exemptions.json. lifeCycle has no exemption, so every combination has it.
 */

type PluginName = "ownership" | "audit" | "softDelete" | "lifeCycle";

const COMBINATIONS: {name: string; plugins: PluginName[]; example: string}[] = [
    {name: "Full", plugins: ["ownership", "audit", "softDelete", "lifeCycle"], example: "Country"},
    {name: "LifeCycleOnly", plugins: ["lifeCycle"], example: "CronLock, metric rollups, PaymentWebhookEvent, RolePermission"},
    {name: "OwnershipLifeCycle", plugins: ["ownership", "lifeCycle"], example: "ApiAccess, CronExecution, AuditLog, DashboardCache"},
    {name: "AuditLifeCycle", plugins: ["audit", "lifeCycle"], example: "User, LastChannelReadMessage"},
    {name: "NoSoftDelete", plugins: ["ownership", "audit", "lifeCycle"], example: "Channel, Message"},
    {name: "NoAudit", plugins: ["ownership", "softDelete", "lifeCycle"], example: "RentalSearchStat, PipelineRunLog"},
];

const APPLY: Record<PluginName, (schema: Schema) => void> = {
    ownership: (schema) => ownershipPlugin(schema),
    audit: auditPlugin,
    softDelete: (schema) => softDeletePlugin(schema),
    lifeCycle: lifeCyclePlugin,
};

interface IProbe {
    title?: string;
    company?: Types.ObjectId;
    createdAt?: Date;
    updatedAt?: Date;
}

const company = new Types.ObjectId();
const models = new Map<string, Model<IProbe>>();
for (const combination of COMBINATIONS) {
    const schema = new Schema<IProbe>({title: String});
    for (const plugin of combination.plugins) APPLY[plugin](schema);
    models.set(combination.name, mongoose.model<IProbe>(`PluginStack${combination.name}`, schema));
}

/** Runs `fn` in a request of `company`; a query only executes when awaited, so it is awaited inside. */
const inTenant = <T>(fn: () => PromiseLike<T>): Promise<T> =>
    requestContext.run({tenantCompanyId: company.toString()}, async () => await fn());

/** Real time moves on, so the next stamp is strictly later than the last one. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const TENANT_INDEX = JSON.stringify([{company: 1, _id: 1}, {background: true}]);

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

describe.each(COMBINATIONS)("plugin stack $name ($example)", {timeout: 60000}, ({name, plugins}) => {
    const model = () => models.get(name)!;
    const has = (plugin: PluginName) => plugins.includes(plugin);

    it("defines createdAt and updatedAt as server-owned, filterable dates", () => {
        for (const path of ["createdAt", "updatedAt"]) {
            const type = model().schema.path(path);
            expect(type.instance).toBe("Date");
            expect(type.options.permissions).toEqual({self: {write: "no-permission"}, others: {write: "no-permission"}});
            expect(type.options.dynamicTableConfiguration).toEqual({filterable: true, sortable: true, cellType: COLUMN_TYPE.DATETIME, visible: false});
        }
    });

    it("turns on Mongoose timestamps only through the audit plugin", () => {
        expect(model().schema.get("timestamps")).toBe(has("audit") ? true : undefined);
    });

    it("declares the {company, _id} index once where ownership adds company, plus each plugin's own indexes", () => {
        const indexes = model().schema.indexes().map((index) => JSON.stringify(index));
        expect(indexes.filter((index) => index === TENANT_INDEX)).toHaveLength(has("ownership") ? 1 : 0);
        const expected = [
            ...(has("ownership") ? [TENANT_INDEX, JSON.stringify([{createdBy: 1}, {background: true}])] : []),
            ...(has("softDelete") ? [JSON.stringify([{deletedAt: 1}, {background: true}])] : []),
        ];
        expect([...indexes].sort()).toEqual([...expected].sort());
    });

    it("stamps a create with now, replacing a createdAt the caller passed", async () => {
        const before = new Date();
        const doc = await inTenant(() => model().create({title: "new", company, createdAt: new Date("2001-01-01T00:00:00Z")}));
        expect(doc.createdAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(doc.updatedAt!.getTime()).toBeGreaterThanOrEqual(doc.createdAt!.getTime());
    });

    it("bumps updatedAt on every save, with or without a change, and keeps createdAt", async () => {
        const doc = await inTenant(() => model().create({title: "saved", company}));
        const createdAt = doc.createdAt!.getTime();
        let last = doc.updatedAt!.getTime();

        await tick();
        doc.title = "saved again";
        await inTenant(() => doc.save());
        expect(doc.updatedAt!.getTime()).toBeGreaterThan(last);
        last = doc.updatedAt!.getTime();

        await tick();
        await inTenant(() => doc.save());
        expect(doc.updatedAt!.getTime()).toBeGreaterThan(last);

        const stored = await inTenant(() => model().findById(doc._id).lean());
        expect(stored!.createdAt!.getTime()).toBe(createdAt);
        expect(stored!.updatedAt!.getTime()).toBe(doc.updatedAt!.getTime());
    });

    it("bumps updatedAt on findOneAndUpdate, updateOne and updateMany", async () => {
        const doc = await inTenant(() => model().create({title: "updated", company}));
        let last = doc.updatedAt!.getTime();
        const storedUpdatedAt = async () => (await inTenant(() => model().findById(doc._id).lean()))!.updatedAt!.getTime();

        const updates: (() => PromiseLike<unknown>)[] = [
            () => model().findOneAndUpdate({_id: doc._id}, {$set: {title: "a"}}),
            () => model().updateOne({_id: doc._id}, {$set: {title: "b"}}),
            () => model().updateMany({_id: doc._id}, {$set: {title: "c"}}),
        ];
        for (const update of updates) {
            await tick();
            await inTenant(update);
            const now = await storedUpdatedAt();
            expect(now).toBeGreaterThan(last);
            last = now;
        }
        expect((await inTenant(() => model().findById(doc._id).lean()))!.createdAt!.getTime()).toBe(doc.createdAt!.getTime());
    });
});

describe("the {company, _id} index", () => {
    const tenantIndexes = (name: string, build: (schema: Schema) => void): number => {
        const schema = new Schema({title: String});
        build(schema);
        return mongoose.model(`PluginStackIndex${name}`, schema).schema.indexes()
            .filter((index) => JSON.stringify(index) === TENANT_INDEX).length;
    };

    it("is added once when lifeCycle runs before ownership adds company", () => {
        expect(tenantIndexes("LifeCycleFirst", (schema) => {
            lifeCyclePlugin(schema);
            ownershipPlugin(schema);
        })).toBe(1);
    });

    it("is added for a company the schema declares itself, without ownership", () => {
        expect(tenantIndexes("OwnCompany", (schema) => {
            schema.add({company: {type: Schema.Types.ObjectId, ref: "Company"}});
            lifeCyclePlugin(schema);
        })).toBe(1);
    });

    it("is not added to a schema without company", () => {
        expect(tenantIndexes("NoCompany", (schema) => lifeCyclePlugin(schema))).toBe(0);
    });
});

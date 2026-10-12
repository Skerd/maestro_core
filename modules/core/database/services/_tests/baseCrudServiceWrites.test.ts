import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {MongoMemoryReplSet} from "mongodb-memory-server";
import mongoose, {Schema, type Document} from "mongoose";
import {ObjectId} from "mongodb";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import AuditLog from "@coreModule/database/schemas/auditLog/auditLog";
import {BaseCrudService} from "@coreModule/database/services/baseCrudService";

interface IGadget extends Document {
    code: string;
    color?: "red" | "blue";
    count: number;
    company: ObjectId;
}

const GadgetSchema = new Schema<IGadget>({
    code: {type: String, required: true, unique: true},
    color: {type: String, enum: ["red", "blue"]},
    count: {type: Number, min: 0, default: 0},
    company: {type: Schema.Types.ObjectId, required: true},
});
auditPlugin(GadgetSchema);
const Gadget = mongoose.model<IGadget>("CrudWriteGadget", GadgetSchema);
// Named after a model whose `<model>_already_exists` code has a message
const gadgets = new BaseCrudService<IGadget, typeof Gadget>(Gadget, "Warehouse");

let replSet: MongoMemoryReplSet;
const company = new ObjectId();
const actor = new ObjectId();

beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({replSet: {count: 1}});
    await mongoose.connect(replSet.getUri());
    await Gadget.init();
}, 120000);

afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
});

beforeEach(async () => {
    await Promise.all([Gadget.deleteMany({}), AuditLog.deleteMany({})]);
});

describe("BaseCrudService.updateById with operators (E-14)", {timeout: 30000}, () => {
    it("runs validators on the changed paths and answers with the field", async () => {
        const gadget = await Gadget.create({code: "A", company});

        await expect(gadgets.updateById(gadget._id, {$set: {color: ""}}, {auditUserId: actor}))
            .rejects.toMatchObject({error_code: "field_value_invalid", status: 400});
        await expect(gadgets.updateById(gadget._id, {$set: {count: -1}}, {auditUserId: actor}))
            .rejects.toMatchObject({error_code: "field_value_invalid"});
        expect((await Gadget.findById(gadget._id))!.color).toBeUndefined();
    });

    it("records an audit entry in the caller's transaction", async () => {
        const gadget = await Gadget.create({code: "A", company});

        const updated = await gadgets.updateById(gadget._id, {$set: {color: "red"}, $inc: {count: 2}}, {auditUserId: actor});
        expect(updated!.color).toBe("red");
        const entry = await AuditLog.findOne({documentId: gadget._id, action: "UPDATE"});
        expect(entry!.diff).toMatchObject({color: {from: null, to: "red"}, count: {from: 0, to: 2}});
        expect(entry!.actorId!.toString()).toBe(actor.toString());

        const session = await mongoose.startSession();
        session.startTransaction();
        await gadgets.updateById(gadget._id, {$set: {color: "blue"}}, {auditUserId: actor, session});
        await session.abortTransaction();
        await session.endSession();
        expect(await AuditLog.countDocuments({documentId: gadget._id, action: "UPDATE"})).toBe(1);
    });

    it("maps a duplicate key and returns the old document when asked", async () => {
        await Gadget.create({code: "A", company});
        const second = await Gadget.create({code: "B", company});

        await expect(gadgets.updateById(second._id, {$set: {code: "A"}}, {auditUserId: actor}))
            .rejects.toMatchObject({error_code: "warehouse_already_exists", status: 400});

        const before = await gadgets.updateById(second._id, {$set: {color: "blue"}}, {auditUserId: actor, returnNew: false});
        expect(before!.color).toBeUndefined();
    });
});

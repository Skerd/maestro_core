import {describe, expect, it} from "vitest";
import mongoose, {Schema, Types} from "mongoose";
import {collectObjectIds, referencedModelName} from "../auditReferenceLabels";

const schema = new Schema({
    project: {type: Schema.Types.ObjectId, ref: "Project"},
    constructors: [{type: Schema.Types.ObjectId, ref: "Constructor"}],
    name: String,
    plain: Schema.Types.ObjectId,
});
const Model = mongoose.model("AuditRefLabelTest", schema);

describe("referencedModelName", () => {
    it("finds scalar and array refs only", () => {
        expect(referencedModelName(Model, "project")).toBe("Project");
        expect(referencedModelName(Model, "constructors")).toBe("Constructor");
        expect(referencedModelName(Model, "name")).toBeUndefined();
        expect(referencedModelName(Model, "plain")).toBeUndefined();
        expect(referencedModelName(Model, "missing")).toBeUndefined();
    });
});

describe("collectObjectIds", () => {
    it("reads ids from strings, ObjectIds, {_id} and arrays", () => {
        const a = new Types.ObjectId();
        const b = "AAAAAAAAAAAAAAAAAAAAAAA1";
        const ids = collectObjectIds([a, {_id: b}, [null, "not an id", 5]]);
        expect([...ids].sort()).toEqual([a.toHexString(), b.toLowerCase()].sort());
    });
});

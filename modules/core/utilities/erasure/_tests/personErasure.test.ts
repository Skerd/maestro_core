import {describe, expect, it, vi} from "vitest";

// Core fixtures only (CORE-07): discovery sees no vertical module.
vi.mock("@coreModule/utilities/modules/enabledModules", () => ({isModuleEnabled: (name: string) => name === "core"}));
import {Types} from "mongoose";
import {erasePersonInCompany, erasureSubject, objectIds, personErasureModules, registerPersonEraser, type ErasureContext} from "../personErasure";

describe("person erasure seam (D57)", () => {
    it("normalises who to erase and skips invalid account ids", () => {
        const id = new Types.ObjectId();
        expect(erasureSubject({emails: [" Ada@Example.com ", "ada@example.com", ""], accountIds: [id.toString(), "nope"]}))
            .toEqual({emails: ["ada@example.com"], accountIds: [id]});
        expect(objectIds([id, {_id: id}, "x", undefined])).toEqual([id, id]);
    });

    it("hands each registered eraser the company and person, and does nothing for nobody", async () => {
        const seen: ErasureContext[] = [];
        registerPersonEraser({module: "fixture", erase: async (ctx) => {
            seen.push(ctx);
            return [{collection: "fixtures", anonymised: 2, deleted: 1}];
        }});
        const companyId = new Types.ObjectId();

        expect(await erasePersonInCompany({companyId, subject: erasureSubject({}), preview: true})).toEqual([]);
        expect(seen).toHaveLength(0);

        const counts = await erasePersonInCompany({companyId, subject: erasureSubject({emails: ["ada@example.com"]}), preview: true});
        expect(counts).toEqual(expect.arrayContaining([{collection: "fixtures", anonymised: 2, deleted: 1}, {collection: "media", anonymised: 0, deleted: 0}]));
        expect(seen.find((ctx) => ctx.subject.emails[0] === "ada@example.com")).toMatchObject({companyId, preview: true});
        expect(await personErasureModules()).toContain("fixture");
    });
});

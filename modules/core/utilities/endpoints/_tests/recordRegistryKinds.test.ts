import {describe, expect, it} from "vitest";
import {Router} from "express";
import mongoose, {Schema} from "mongoose";
import {z} from "zod";
import {getRecordResource, recordRouterMounted, registerRecordResource} from "@coreModule/utilities/endpoints/recordRegistry";

const model = mongoose.model("RecordRegistryKindsFixture", new Schema({name: String}));

function mount(collection: string): void {
    const router = Router();
    registerRecordResource(router, {collection, model, selectSchema: () => z.object({}), runSelect: async () => ({data: [], total: 0})});
    recordRouterMounted(router, "core");
}

// TD-F130: chat's "Share a record" offered sign-ins and sessions (IP addresses, devices) as cards.
describe("chat record kinds", () => {
    it("never offers a person's sign-ins or sessions", () => {
        mount("loginhistories");
        mount("userSessions");
        expect(getRecordResource("loginhistories")).toBeUndefined();
        expect(getRecordResource("usersessions")).toBeUndefined();
    });

    it("still offers every other resource that registers", () => {
        mount("recordRegistryKindsThings");
        expect(getRecordResource("recordregistrykindsthings")?.moduleName).toBe("core");
    });
});

import {describe, expect, it} from "vitest";
import {model, Schema, SchemaTypes, type Document} from "mongoose";
import {addModelData} from "@coreModule/database/collections";
import type {UserContext} from "@coreModule/utilities/types/types";
import {readableListFetch} from "../readableListFetch";

/** Probe documents: only the schema metadata matters to SchemaGuard. */
type ProbeDocument = Document & Record<string, unknown>;

const HubProbe = model<ProbeDocument>("ReadableListFetchProbe", new Schema<ProbeDocument>({
    name: {type: SchemaTypes.String, permissions: {others: {read: "probe-read"}}},
    secret: {type: SchemaTypes.String, permissions: {others: {read: "probe-secret-read"}}},
}, {accessMode: "strict"}));
addModelData(HubProbe);

const Unregistered = model<ProbeDocument>("ReadableListFetchUnregistered", new Schema<ProbeDocument>({
    name: {type: SchemaTypes.String},
}));

function ctx(permissions: string[]): {actionUserCtx: UserContext; languageCode: string} {
    return {actionUserCtx: {userId: "u1", orgId: "o1", isAdmin: false, permissions, isSelf: false}, languageCode: "en-US"};
}

describe("readableListFetch", () => {
    it("selects only the fields the role can read", () => {
        const fetch = readableListFetch(HubProbe, ctx(["probe-read"]));
        expect(fetch?.select).toContain("name");
        expect(fetch?.select).not.toContain("secret");
    });

    it("returns null when the role reads nothing on the model", () => {
        expect(readableListFetch(HubProbe, ctx([]))).toBeNull();
    });

    it("returns null for a model no module registered", () => {
        expect(readableListFetch(Unregistered, ctx(["probe-read"]))).toBeNull();
    });
});

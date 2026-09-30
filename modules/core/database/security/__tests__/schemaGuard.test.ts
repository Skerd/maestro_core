import {describe, expect, it} from "vitest";
import {model, Schema, SchemaTypes} from "mongoose";
import SchemaGuard from "../schemaGuard";
import type {UserContext} from "@coreModule/utilities/types/types";

const ProbeSchema = new Schema({
    name: {
        type: SchemaTypes.String,
        permissions: {
            self: {publicRead: true, write: "probe-self-write"},
            others: {read: "probe-others-read", write: "probe-others-write"},
        },
    },
}, {accessMode: "strict"});

const Probe = model("SchemaGuardProbe", ProbeSchema);

function ctx(overrides: Partial<UserContext> = {}): UserContext {
    return {
        userId: "u1",
        orgId: "o1",
        isAdmin: false,
        permissions: [],
        isSelf: true,
        ...overrides,
    };
}

describe("SchemaGuard.sanitizeFields", () => {
    it("allows a public-read field for self", () => {
        const sanitized = SchemaGuard.sanitizeFields(Probe, {name: {}}, "read", ctx({isSelf: true}), "en-US");
        expect(sanitized).toEqual({name: {}});
    });

    it("denies others-read without the others permission", () => {
        expect(() =>
            SchemaGuard.sanitizeFields(Probe, {name: {}}, "read", ctx({isSelf: false}), "en-US"),
        ).toThrow();
    });

    it("allows others-read when the user holds the others permission", () => {
        const sanitized = SchemaGuard.sanitizeFields(
            Probe,
            {name: {}},
            "read",
            ctx({isSelf: false, permissions: ["probe-others-read"]}),
            "en-US",
        );
        expect(sanitized).toEqual({name: {}});
    });

    it("allows others-write when the user holds the others write permission", () => {
        const sanitized = SchemaGuard.sanitizeFields(
            Probe,
            {name: {}},
            "write",
            ctx({isSelf: false, permissions: ["probe-others-write"]}),
            "en-US",
        );
        expect(sanitized).toEqual({name: {}});
    });
});

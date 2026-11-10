import {describe, expect, it, vi} from "vitest";

vi.mock("@coreModule/environment", () => ({
    CONSTANTS: {DEFAULT_LANGUAGE: "en-US"},
    // The instance zone a route without authMW validates in.
    SERVER: {TIMEZONE: "Europe/Tirane"},
}));

import {z} from "zod";
import {validateFormZod} from "../validateFormZod";
import {stripServerKeys} from "../serverKeys";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";
import type {ValidationContext} from "armonia/src/modules/core/helpers/zodBuilder";

const OBJECT_ID = "6512f0a1b2c3d4e5f6a7b8c9";

describe("validateFormZod", () => {
    it("merges parsed fields on a valid country-style single form", () => {
        const next = vi.fn();
        const req = {body: {languageCode: "en-US", _id: OBJECT_ID}};
        validateFormZod(validateSingleForm)(req as never, {} as never, next);
        expect(next).toHaveBeenCalledWith();
        expect(req.body._id).toBe(OBJECT_ID);
    });

    it("fails when _id is missing", () => {
        const next = vi.fn();
        validateFormZod(validateSingleForm)({body: {languageCode: "en-US"}} as never, {} as never, next);
        expect(next.mock.calls[0]![0]).toBeInstanceOf(Error);
    });
});

describe("validateFormZod's validation context (D116)", () => {
    /** Runs the guard, then (optionally) what authMW writes, then validateFormZod; returns the context the factory got. */
    function contextFor(clientBody: Record<string, unknown>, serverZone?: string): ValidationContext | undefined {
        const req = {body: clientBody, originalUrl: "/api/x"};
        stripServerKeys(req as never, {} as never, () => undefined);
        if (serverZone) req.body.companyTimeZone = serverZone;
        let received: ValidationContext | undefined;
        const factory = (_lang: string | undefined, _form?: unknown, _write?: unknown, _read?: unknown, context?: ValidationContext) => {
            received = context;
            return z.object({});
        };
        validateFormZod(factory)(req as never, {} as never, () => undefined);
        return received;
    }

    it("hands the factory the company zone authMW wrote", () => {
        expect(contextFor({}, "Europe/Zurich")).toEqual({timeZone: "Europe/Zurich"});
    });

    it("uses the instance zone on a route without authMW", () => {
        expect(contextFor({})).toEqual({timeZone: "Europe/Tirane"});
    });

    it("ignores a companyTimeZone the client sent", () => {
        expect(contextFor({companyTimeZone: "Pacific/Kiritimati"})).toEqual({timeZone: "Europe/Tirane"});
        expect(contextFor({companyTimeZone: "Pacific/Kiritimati"}, "Europe/Zurich")).toEqual({timeZone: "Europe/Zurich"});
    });
});

import {describe, expect, it, vi} from "vitest";

vi.mock("@coreModule/environment", () => ({
    CONSTANTS: {DEFAULT_LANGUAGE: "en-US"},
}));

import {validateFormZod} from "../validateFormZod";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";

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

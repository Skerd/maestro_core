import {beforeEach, describe, expect, it} from "vitest";
import {
    assertCronHandlerRegistered,
    clearCronHandlersForTests,
    registerCronHandler,
} from "../registry/handlerRegistry";

describe("handlerRegistry", () => {
    beforeEach(() => clearCronHandlersForTests());

    it("registers and resolves handlers", async () => {
        registerCronHandler({
            code: "test.job",
            handler: async () => {},
        });
        expect(() => assertCronHandlerRegistered("test.job")).not.toThrow();
        expect(() => assertCronHandlerRegistered("missing")).toThrow();
    });
});

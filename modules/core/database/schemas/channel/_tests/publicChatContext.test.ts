import {describe, expect, it} from "vitest";
import {
    getPublicChatContextTag,
    getPublicChatPopulate,
    registerPublicChatContext,
    resetPublicChatContextForTests,
} from "../publicChatContext";

describe("public chat context registry", () => {
    it("has no populate or tag until a feature module registers", () => {
        resetPublicChatContextForTests();
        expect(getPublicChatContextTag()).toBeUndefined();
        expect(getPublicChatPopulate()).toEqual([]);
    });

    it("stores the first registration's tag and populate paths", () => {
        resetPublicChatContextForTests();
        registerPublicChatContext({
            tag: "feature",
            populate: [
                {path: "publicChat.lead", model: "CrmRecord"},
                {path: "publicChat.context.listing", model: "Listing", select: "name"},
            ],
        });
        expect(getPublicChatContextTag()).toBe("feature");
        expect(getPublicChatPopulate()).toEqual([
            {path: "publicChat.lead", model: "CrmRecord"},
            {path: "publicChat.context.listing", model: "Listing", select: "name"},
        ]);
    });
});

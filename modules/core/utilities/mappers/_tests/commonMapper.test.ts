import {describe, expect, it} from "vitest";
import {ObjectId} from "mongodb";
import {mapMedia} from "@coreModule/utilities/mappers/common.mapper";

describe("mapMedia size (TD-B112)", () => {
    const _id = new ObjectId();

    it("takes the size from metadata when it is there", () => {
        expect(mapMedia({_id, metadata: {size: 1200}, sizeInBytes: 900})?.size).toBe(1200);
    });

    it("falls back to sizeInBytes when the populate left out metadata", () => {
        expect(mapMedia({_id, fileName: "opg.png", sizeInBytes: 900})?.size).toBe(900);
    });

    it("answers 0 when neither is stored", () => {
        expect(mapMedia({_id})?.size).toBe(0);
    });
});

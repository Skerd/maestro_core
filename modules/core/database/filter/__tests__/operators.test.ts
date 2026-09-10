import {describe, expect, it} from "vitest";
import {COLUMN_TYPE} from "armonia/src/modules/core/database/filter/typeOperators";
import {OPERATOR_HANDLERS} from "armonia/src/modules/core/database/filter/operators";
import type {FilterFieldConfig} from "armonia/src/modules/core/database/filter/fieldRegistry.types";

function field(type: COLUMN_TYPE): FilterFieldConfig {
    return {path: "rate", type};
}

describe("OPERATOR_HANDLERS", () => {
    it("compares percentage fields as numbers", () => {
        expect(OPERATOR_HANDLERS.greaterThan("rate", 10, field(COLUMN_TYPE.PERCENTAGE))).toEqual({
            rate: {$gt: 10},
        });
        expect(OPERATOR_HANDLERS.between("rate", [5, 15], field(COLUMN_TYPE.PERCENTAGE))).toEqual({
            rate: {$gte: 5, $lte: 15},
        });
    });

    it("treats file exists as attachment present, not BSON $exists", () => {
        expect(OPERATOR_HANDLERS.exists("mediaFiles", true, field(COLUMN_TYPE.FILE))).toEqual({
            $or: [
                {mediaFiles: {$type: "objectId"}},
                {"mediaFiles.0": {$exists: true}},
            ],
        });
        expect(OPERATOR_HANDLERS.exists("mainImage", false, field(COLUMN_TYPE.AVATAR))).toEqual({
            $nor: [
                {
                    $or: [
                        {mainImage: {$type: "objectId"}},
                        {"mainImage.0": {$exists: true}},
                    ],
                },
            ],
        });
    });

    it("keeps scalar exists as BSON $exists", () => {
        expect(OPERATOR_HANDLERS.exists("name", true, field(COLUMN_TYPE.STRING))).toEqual({
            name: {$exists: true},
        });
    });

    it("treats array exists as at least one element", () => {
        expect(OPERATOR_HANDLERS.exists("sharedSpaces", true, field(COLUMN_TYPE.ARRAY))).toEqual({
            "sharedSpaces.0": {$exists: true},
        });
        expect(OPERATOR_HANDLERS.exists("sharedSpaces", false, field(COLUMN_TYPE.ARRAY))).toEqual({
            "sharedSpaces.0": {$exists: false},
        });
    });

    it("applies contains to array elements as a string regex", () => {
        expect(OPERATOR_HANDLERS.contains("sharedSpaces", "lobby", field(COLUMN_TYPE.ARRAY))).toEqual({
            sharedSpaces: {$regex: "lobby", $options: "i"},
        });
    });
});

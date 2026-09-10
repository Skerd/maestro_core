import {describe, expect, it} from "vitest";
import {model, Schema, SchemaTypes} from "mongoose";
import {ARRAY_OPERATORS, COLUMN_TYPE, EXISTENCE_OPERATORS, NUMBER_OPERATORS} from "armonia/src/modules/core/database/filter/typeOperators";
import {buildTableColumnsFromSchema} from "../schemaToTableConfig";

describe("buildTableColumnsFromSchema", () => {
    const TestSchema = new Schema({
        saleCommissionRatePercent: {
            type: SchemaTypes.Decimal128,
            dynamicTableConfiguration: {cellType: COLUMN_TYPE.PERCENTAGE},
        },
        mainImage: {
            type: SchemaTypes.ObjectId,
            ref: "Media",
            dynamicTableConfiguration: {sortable: false, cellType: COLUMN_TYPE.AVATAR},
        },
        mediaFiles: {
            type: [{type: SchemaTypes.ObjectId, ref: "Media"}],
            dynamicTableConfiguration: {sortable: false},
        },
        name: {type: SchemaTypes.String},
        sharedSpaces: {type: [{type: SchemaTypes.String}]},
    });
    const TestModel = model("SchemaToTableConfigProbe", TestSchema);

    it("maps Decimal128 percentages to number operators", () => {
        const columns = buildTableColumnsFromSchema(
            TestModel,
            new Set(["saleCommissionRatePercent"]),
        );
        expect(columns).toHaveLength(1);
        expect(columns[0]!.cellType).toBe(COLUMN_TYPE.PERCENTAGE);
        expect(columns[0]!.sortable).toBe(true);
        expect(columns[0]!.filterConfig).toEqual({
            type: COLUMN_TYPE.PERCENTAGE,
            operators: NUMBER_OPERATORS,
        });
    });

    it("maps primitive string lists to array filters", () => {
        const columns = buildTableColumnsFromSchema(
            TestModel,
            new Set(["sharedSpaces"]),
        );
        expect(columns).toHaveLength(1);
        expect(columns[0]!.cellType).toBe(COLUMN_TYPE.ARRAY);
        expect(columns[0]!.filterConfig).toEqual({
            type: COLUMN_TYPE.ARRAY,
            operators: ARRAY_OPERATORS,
        });
    });

    it("maps media refs to existence-only filters", () => {
        const columns = buildTableColumnsFromSchema(
            TestModel,
            new Set(["mainImage", "mediaFiles"]),
        );
        const byId = Object.fromEntries(columns.map((c) => [c.id, c]));
        expect(byId.mainImage!.cellType).toBe(COLUMN_TYPE.AVATAR);
        expect(byId.mainImage!.sortable).toBe(false);
        expect(byId.mainImage!.filterConfig).toEqual({
            type: COLUMN_TYPE.AVATAR,
            operators: EXISTENCE_OPERATORS,
        });
        expect(byId.mediaFiles!.cellType).toBe(COLUMN_TYPE.FILE);
        expect(byId.mediaFiles!.filterConfig).toEqual({
            type: COLUMN_TYPE.FILE,
            operators: EXISTENCE_OPERATORS,
        });
    });
});

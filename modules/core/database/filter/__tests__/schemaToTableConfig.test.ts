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

    it("passes declared enum tones through to the column meta", () => {
        const ToneSchema = new Schema({
            status: {
                type: SchemaTypes.String,
                enum: ["won", "lost", "negotiation", "new"],
                dynamicTableConfiguration: {
                    enumTones: {won: "success", lost: "danger", negotiation: "warning"},
                },
            },
        });
        const ToneModel = model("SchemaToTableConfigTonesProbe", ToneSchema);
        const columns = buildTableColumnsFromSchema(ToneModel, new Set(["status"]));
        expect(columns[0]!.meta?.enumTones).toEqual({
            won: "success",
            lost: "danger",
            negotiation: "warning",
        });
    });

    it("drops tones the client cannot paint instead of shipping a dead class name", () => {
        const BadToneSchema = new Schema({
            status: {
                type: SchemaTypes.String,
                enum: ["won", "lost"],
                /* "succes" is a typo and "bg-red-500" is a schema reaching for the palette. */
                dynamicTableConfiguration: {
                    enumTones: {won: "succes", lost: "bg-red-500", other: "info"} as never,
                },
            },
            note: {
                type: SchemaTypes.String,
                dynamicTableConfiguration: {enumTones: {} as never},
            },
        });
        const BadToneModel = model("SchemaToTableConfigBadTonesProbe", BadToneSchema);
        const columns = buildTableColumnsFromSchema(BadToneModel, new Set(["status", "note"]));
        const byId = Object.fromEntries(columns.map((c) => [c.id, c]));
        expect(byId.status!.meta?.enumTones).toEqual({other: "info"});
        /* An empty map must not create a `meta` the client then has to defend against. */
        expect(byId.note!.meta?.enumTones).toBeUndefined();
    });

    it("maps nested receipt media to a filterable FILE column", () => {
        const NestedSchema = new Schema({
            paymentReceipts: {
                type: [{
                    amount: {type: SchemaTypes.Number},
                    media: {
                        type: [{type: SchemaTypes.ObjectId, ref: "Media"}],
                        dynamicTableConfiguration: {
                            cellType: COLUMN_TYPE.FILE,
                            filterable: true,
                            sortable: false,
                            dtoPath: "paymentReceiptsMedia",
                        },
                    },
                }],
                dynamicTableConfiguration: {
                    cellType: COLUMN_TYPE.OBJECT_ID,
                    filterable: false,
                    sortable: false,
                },
            },
        });
        const NestedModel = model("SchemaToTableConfigNestedMediaProbe", NestedSchema);
        const columns = buildTableColumnsFromSchema(
            NestedModel,
            new Set(["paymentReceipts", "paymentReceipts.amount", "paymentReceipts.media"]),
        );
        const byId = Object.fromEntries(columns.map((c) => [c.id, c]));
        expect(byId["paymentReceipts.media"]!.cellType).toBe(COLUMN_TYPE.FILE);
        expect(byId["paymentReceipts.media"]!.dtoPath).toBe("paymentReceiptsMedia");
        expect(byId["paymentReceipts.media"]!.filterConfig).toEqual({
            type: COLUMN_TYPE.FILE,
            operators: EXISTENCE_OPERATORS,
        });
        expect(byId.paymentReceipts!.filterConfig).toBeUndefined();
    });
});

import {describe, expect, it} from "vitest";
import {model, Schema, SchemaTypes, type Document} from "mongoose";
import {ARRAY_OPERATORS, COLUMN_TYPE, DATE_OPERATORS, EXISTENCE_OPERATORS, NUMBER_OPERATORS} from "armonia/src/modules/core/database/filter/typeOperators";
import {buildTableColumnsFromSchema} from "../schemaToTableConfig";
import {ownershipPlugin} from "@coreModule/database/plugins/ownershipPlugin";

/** Probe documents: only the schema metadata matters to the table builder. */
type ProbeDocument = Document & Record<string, unknown>;

describe("buildTableColumnsFromSchema", () => {
    const TestSchema = new Schema<ProbeDocument>({
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
        dueDate: {type: SchemaTypes.String, dynamicTableConfiguration: {cellType: COLUMN_TYPE.DATE}},
        sharedSpaces: {type: [{type: SchemaTypes.String}]},
    });
    const TestModel = model<ProbeDocument>("SchemaToTableConfigProbe", TestSchema);

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
        const ToneSchema = new Schema<ProbeDocument>({
            status: {
                type: SchemaTypes.String,
                enum: ["won", "lost", "negotiation", "new"],
                dynamicTableConfiguration: {
                    enumTones: {won: "success", lost: "danger", negotiation: "warning"},
                },
            },
        });
        const ToneModel = model<ProbeDocument>("SchemaToTableConfigTonesProbe", ToneSchema);
        const columns = buildTableColumnsFromSchema(ToneModel, new Set(["status"]));
        expect(columns[0]!.meta?.enumTones).toEqual({
            won: "success",
            lost: "danger",
            negotiation: "warning",
        });
    });

    it("passes a money column's currency path through to the column meta (D149)", () => {
        const MoneySchema = new Schema<ProbeDocument>({
            price: {type: SchemaTypes.Decimal128, dynamicTableConfiguration: {currencyPath: "priceCurrency"}},
            totals: {type: {total: {type: SchemaTypes.Number, dynamicTableConfiguration: {currencyPath: "currency"}}}},
            area: {type: SchemaTypes.Number},
        });
        const MoneyModel = model<ProbeDocument>("SchemaToTableConfigMoneyProbe", MoneySchema);
        const columns = buildTableColumnsFromSchema(MoneyModel, new Set(["price", "totals.total", "area"]));
        const metaOf = (id: string) => columns.find((column) => column.id === id)?.meta;
        expect(metaOf("price")?.currencyPath).toBe("priceCurrency");
        expect(metaOf("totals.total")?.currencyPath).toBe("currency");
        expect(metaOf("area")?.currencyPath).toBeUndefined();
    });

    it("drops tones the client cannot paint instead of shipping a dead class name", () => {
        const BadToneSchema = new Schema<ProbeDocument>({
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
        const BadToneModel = model<ProbeDocument>("SchemaToTableConfigBadTonesProbe", BadToneSchema);
        const columns = buildTableColumnsFromSchema(BadToneModel, new Set(["status", "note"]));
        const byId = Object.fromEntries(columns.map((c) => [c.id, c]));
        expect(byId.status!.meta?.enumTones).toEqual({other: "info"});
        /* An empty map must not create a `meta` the client then has to defend against. */
        expect(byId.note!.meta?.enumTones).toBeUndefined();
    });

    it("maps nested receipt media to a filterable FILE column", () => {
        const NestedSchema = new Schema<ProbeDocument>({
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
        const NestedModel = model<ProbeDocument>("SchemaToTableConfigNestedMediaProbe", NestedSchema);
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

    it("maps Date fields to DATE unless overridden as DATETIME", () => {
        const DateSchema = new Schema<ProbeDocument>({
            dueDate: {type: SchemaTypes.Date},
            scheduledAt: {
                type: SchemaTypes.Date,
                dynamicTableConfiguration: {cellType: COLUMN_TYPE.DATETIME},
            },
        });
        const DateModel = model<ProbeDocument>("SchemaToTableConfigDateProbe", DateSchema);
        const columns = buildTableColumnsFromSchema(DateModel, new Set(["dueDate", "scheduledAt"]));
        const byId = Object.fromEntries(columns.map((c) => [c.id, c]));
        expect(byId.dueDate!.cellType).toBe(COLUMN_TYPE.DATE);
        expect(byId.dueDate!.filterConfig).toEqual({
            type: COLUMN_TYPE.DATE,
            operators: DATE_OPERATORS,
        });
        expect(byId.scheduledAt!.cellType).toBe(COLUMN_TYPE.DATETIME);
        expect(byId.scheduledAt!.filterConfig).toEqual({
            type: COLUMN_TYPE.DATETIME,
            operators: DATE_OPERATORS,
        });
    });

    // D115: a calendar day stored as `YYYY-MM-DD` text keeps its date filters (plus month prefixes).
    it("gives a local-day text column date operators", () => {
        const columns = buildTableColumnsFromSchema(TestModel, new Set(["dueDate"]));
        expect(columns[0]!.filterConfig).toEqual({
            type: COLUMN_TYPE.DATE,
            operators: [...DATE_OPERATORS, "startsWith"],
            localDay: true,
        });
    });
    it("keeps the owner's Created By column available but hidden by default (D164)", () => {
        const OwnedSchema = new Schema<ProbeDocument>({name: {type: SchemaTypes.String}});
        ownershipPlugin(OwnedSchema);
        const OwnedModel = model<ProbeDocument>("SchemaToTableConfigOwnedProbe", OwnedSchema);
        const createdBy = buildTableColumnsFromSchema(OwnedModel, new Set(["name", "createdBy"])).find((column) => column.id === "createdBy");
        expect(createdBy).toBeDefined();
        expect(createdBy!.visible).toBe(false);
    });

    // D170: `contains` on a reference searches the linked record's names, in the model it names.
    it("offers name search on a reference that names its model", () => {
        const RefSchema = new Schema<ProbeDocument>({
            owner: {type: SchemaTypes.ObjectId, ref: "Owner"},
            tags: {type: [{type: SchemaTypes.ObjectId, ref: "Tag"}]},
            bare: {type: SchemaTypes.ObjectId},
        });
        const RefModel = model<ProbeDocument>("SchemaToTableConfigRefProbe", RefSchema);
        const byId = Object.fromEntries(
            buildTableColumnsFromSchema(RefModel, new Set(["owner", "tags", "bare"])).map((column) => [column.id, column]),
        );
        expect(byId.owner!.filterConfig!.operators).toContain("contains");
        expect(byId.tags!.filterConfig!.operators).toContain("contains");
        expect(byId.bare!.filterConfig!.operators).not.toContain("contains");
        expect(byId.bare!.filterConfig!.operators).toContain("equals");
    });
});

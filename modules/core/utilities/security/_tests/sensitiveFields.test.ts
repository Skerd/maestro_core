import {describe, expect, it} from "vitest";
import {Mongoose, Schema} from "mongoose";
import {findSensitiveSnippetFields, sensitivePaths, sensitivityOfPath, withoutSensitiveFields} from "../sensitiveFields";

describe("sensitive fields (SEC-06)", () => {
    const chartSchema = new Schema({
        title: String,
        history: {type: {notes: String}, sensitivity: "health"},
        visits: [{date: Date, card: {type: String, sensitivity: "payment"}}],
    });

    it("finds marked paths, nested ones included, and lets everything under them inherit", () => {
        const marked = sensitivePaths(chartSchema);
        expect(Object.fromEntries(marked)).toEqual({history: "health", visits_card: "payment"});
        expect(sensitivityOfPath("history.notes", marked)).toBe("health");
        expect(sensitivityOfPath("history_notes", marked)).toBe("health");
        expect(sensitivityOfPath("historyNotes", marked)).toBeUndefined();
        expect(sensitivityOfPath("title", marked)).toBeUndefined();
    });

    it("reports a snippet that exposes a sensitive field of the model it points to", () => {
        const connection = new Mongoose();
        connection.model("Chart", chartSchema);
        connection.model("Visit", new Schema({
            chart: {type: Schema.Types.ObjectId, ref: "Chart", refAllowlist: {keys: {_id: {}, title: {}}}},
        }));
        expect(findSensitiveSnippetFields(connection)).toEqual([]);

        connection.model("Referral", new Schema({
            charts: [{type: Schema.Types.ObjectId, ref: "Chart", refAllowlist: {keys: {title: {}, history: {}}}}],
        }));
        expect(findSensitiveSnippetFields(connection)).toEqual(["Referral.charts → Chart.history"]);
    });

    it("drops sensitive fields from a list selection, keeping _id when nothing else is left", () => {
        expect(withoutSensitiveFields({title: {}, history: {keys: {notes: {}}}}, chartSchema)).toEqual({title: {}});
        expect(withoutSensitiveFields({history: {}}, chartSchema)).toEqual({_id: {}});
        const plain = new Schema({title: String});
        const fields = {title: {}};
        expect(withoutSensitiveFields(fields, plain)).toBe(fields);
    });
});

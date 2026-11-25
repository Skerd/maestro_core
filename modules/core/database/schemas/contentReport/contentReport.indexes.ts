import {Schema} from "mongoose";

export function applyContentReportIndexes(schema: Schema): void {
    // One open report per thing and person (D191): a second one answers `report_already_sent`.
    schema.index({kind: 1, recordId: 1, reporter: 1}, {unique: true, partialFilterExpression: {status: "open", deletedAt: null}});
    // The desk lists the open reports first, newest first; a decision closes every open report of the same thing.
    schema.index({company: 1, status: 1, createdAt: -1});
    schema.index({kind: 1, recordId: 1, status: 1});
}

import {Schema} from "mongoose";

export function applyFinanceIndexes(FinanceSchema: Schema): void {
    // Primary reference indexes
    FinanceSchema.index({ company: 1 });             // For finding finance records by company (most common query)

    // Array field indexes
    FinanceSchema.index({ "currencies.currency": 1 });        // For finding finance records with specific currency

    // Compound indexes for common query patterns
    FinanceSchema.index({ company: 1, "currencies.currency": 1 });  // Company finance by currency
}

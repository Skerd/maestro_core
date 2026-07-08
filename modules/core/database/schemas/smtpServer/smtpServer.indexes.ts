import {Schema} from "mongoose";

export function applySmtpServerIndexes(SmtpServerSchema: Schema): void {
    SmtpServerSchema.index({company: 1, active: 1, sequence: 1});
    SmtpServerSchema.index({company: 1, name: 1}, {unique: true});
    SmtpServerSchema.index({company: 1, createdAt: -1});
}

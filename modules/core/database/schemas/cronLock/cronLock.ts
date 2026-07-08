import {Document, model, Schema, SchemaTypes} from "mongoose";

export interface ICronLock extends Document {
    key: string;
    owner: string;
    token: string;
    expiresAt: Date;
    heartbeatAt: Date;
    createdAt: Date;
}

const CronLockSchema = new Schema<ICronLock>(
    {
        key: {type: SchemaTypes.String, required: true, unique: true},
        owner: {type: SchemaTypes.String, required: true},
        token: {type: SchemaTypes.String, required: true},
        expiresAt: {type: SchemaTypes.Date, required: true, index: true},
        heartbeatAt: {type: SchemaTypes.Date, required: true},
    },
    {timestamps: {createdAt: true, updatedAt: false}},
);

CronLockSchema.index({expiresAt: 1}, {expireAfterSeconds: 0});

const CronLock = model<ICronLock>("CronLock", CronLockSchema);
export default CronLock;

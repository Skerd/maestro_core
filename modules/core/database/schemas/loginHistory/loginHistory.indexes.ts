import {Schema} from "mongoose";

export function applyLoginHistoryIndexes(LoginHistorySchema: Schema): void {
    // Canonical module indexes
    LoginHistorySchema.index({company: 1, createdAt: -1});
    LoginHistorySchema.index({createdAt: -1});

    // Primary reference indexes
    LoginHistorySchema.index({user: 1});
    LoginHistorySchema.index({company: 1});

    // Time-based indexes (most common query pattern)
    LoginHistorySchema.index({time: -1});
    LoginHistorySchema.index({time: 1});

    // Status and authentication indexes
    LoginHistorySchema.index({status: 1});
    LoginHistorySchema.index({mfa: 1});

    // Device and client information indexes
    LoginHistorySchema.index({device: 1});
    LoginHistorySchema.index({os: 1});
    LoginHistorySchema.index({userAgent: 1});

    // Network and security indexes
    LoginHistorySchema.index({ip: 1});
    LoginHistorySchema.index({reason: 1});

    // Geolocation nested field indexes
    LoginHistorySchema.index({"geolocation.country": 1});
    LoginHistorySchema.index({"geolocation.city": 1});
    LoginHistorySchema.index({"geolocation.region": 1});

    // Compound indexes for common query patterns
    LoginHistorySchema.index({user: 1, time: -1});
    LoginHistorySchema.index({user: 1, status: 1});
    LoginHistorySchema.index({user: 1, company: 1, time: -1});
    LoginHistorySchema.index({user: 1, mfa: 1});

    LoginHistorySchema.index({company: 1, time: -1});
    LoginHistorySchema.index({company: 1, status: 1});
    LoginHistorySchema.index({company: 1, mfa: 1});

    LoginHistorySchema.index({status: 1, time: -1});
    LoginHistorySchema.index({ip: 1, time: -1});
    LoginHistorySchema.index({"geolocation.country": 1, time: -1});

    LoginHistorySchema.index({company: 1, status: 1, time: -1});
    LoginHistorySchema.index({user: 1, status: 1, time: -1});
    LoginHistorySchema.index({mfa: 1, status: 1, time: -1});
}

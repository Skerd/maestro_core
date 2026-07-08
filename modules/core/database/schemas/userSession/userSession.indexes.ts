import {Schema} from "mongoose";

export function applyUserSessionIndexes(UserSessionSchema: Schema): void {
    // Canonical module indexes
    UserSessionSchema.index({company: 1, createdAt: -1});
    UserSessionSchema.index({createdAt: -1});

    // Primary reference indexes
    UserSessionSchema.index({user: 1});
    UserSessionSchema.index({company: 1});

    UserSessionSchema.index({sessionId: 1});
    UserSessionSchema.index({deviceId: 1});

    UserSessionSchema.index({isActive: 1});
    UserSessionSchema.index({lastActiveAt: -1});
    UserSessionSchema.index({lastActiveAt: 1});
    UserSessionSchema.index({createdAt: 1});

    UserSessionSchema.index({ipAddress: 1});
    UserSessionSchema.index({userAgent: 1});

    UserSessionSchema.index({"geolocation.country": 1});
    UserSessionSchema.index({"geolocation.city": 1});
    UserSessionSchema.index({"geolocation.region": 1});

    UserSessionSchema.index({user: 1, company: 1});
    UserSessionSchema.index({user: 1, isActive: 1});
    UserSessionSchema.index({user: 1, company: 1, isActive: 1});
    UserSessionSchema.index({user: 1, deviceId: 1});
    UserSessionSchema.index({user: 1, company: 1, deviceId: 1});
    UserSessionSchema.index({user: 1, lastActiveAt: -1});
    UserSessionSchema.index({user: 1, company: 1, lastActiveAt: -1});

    UserSessionSchema.index({company: 1, isActive: 1});
    UserSessionSchema.index({company: 1, lastActiveAt: -1});

    UserSessionSchema.index({deviceId: 1, isActive: 1});
    UserSessionSchema.index({user: 1, deviceId: 1, isActive: 1});

    UserSessionSchema.index({ipAddress: 1, isActive: 1});
    UserSessionSchema.index({isActive: 1, lastActiveAt: -1});
    UserSessionSchema.index({company: 1, isActive: 1, lastActiveAt: -1});
}

import {UserSession} from "armonia/src/modules/core/api/user/private/userSession/userSession.dto";
import type {SimpleBlankUser} from "armonia/src/modules/core/dto/user.dto";
import {IUserSession} from "@coreModule/database/schemas/userSession/userSession";
import {SimpleBlankUserSnippet} from "@coreModule/database/schemas/user/user.snippets";
import {mapLifeCycleToDTO, mapOwnershipToDTO, mapSoftDeleteToDTO} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";
import {mapSnippet} from "@coreModule/utilities/mappers/common.mapper";

export function userSessionToDTO(model: IUserSession): UserSession {
    return {
        _id: model._id.toString(),
        user: mapSnippet<SimpleBlankUser>()(model.user, SimpleBlankUserSnippet),
        sessionId: model.sessionId,
        deviceId: model.deviceId,
        userAgent: model.userAgent,
        ipAddress: model.ipAddress,
        geolocation: model.geolocation ? model.geolocation.map((g) => {
            return {
                ip: g.ip,
                hostname: g.hostname ,
                city: g.city,
                region: g.region,
                country: g.country,
                loc: g.loc,
                org: g.org,
                postal: g.postal,
                timezone: g.timezone,
                time: g.time,
            }
        }) : undefined,
        lastActiveAt: model.lastActiveAt,
        expiresAt: model.expiresAt,
        isActive: model.isActive,
        ...mapSoftDeleteToDTO(model),
        ...mapOwnershipToDTO(model),
        ...mapLifeCycleToDTO(model),
    };
}

export function userSessionsToDTO(models: IUserSession[]): UserSession[] {
    return models.map(userSessionToDTO);
}

import {UserSession} from "armonia/src/modules/core/api/user/private/userSession/userSession.dto";
import {IUserSession} from "@coreModule/database/schemas/userSession/userSession";
import {mapOwnershipToDTO, mapSoftDeleteToDTO} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";
import {mapPopulatedSimpleUser} from "@coreModule/utilities/mappers/common.mapper";

function mapGeolocation(geo: IUserSession["geolocation"]): UserSession["geolocation"] {
    if (!geo?.length) {
        return [];
    }
    return geo.map((g) => ({
        ip: String(g.ip ?? ""),
        hostname: String(g.hostname ?? ""),
        city: String(g.city ?? ""),
        region: String(g.region ?? ""),
        country: String(g.country ?? ""),
        loc: String(g.loc ?? ""),
        org: String(g.org ?? ""),
        postal: String(g.postal ?? ""),
        timezone: String(g.timezone ?? ""),
        time: g.time == null ? null : Number(g.time),
    }));
}

function dateToIso(d: Date | undefined | null): string {
    if (!d) {
        return "";
    }
    return d instanceof Date ? d.toISOString() : new Date(d as unknown as string).toISOString();
}

export function userSessionToDTO(model: IUserSession): UserSession {
    return {
        _id: model._id.toString(),
        user: model.user ? mapPopulatedSimpleUser(model.user) : undefined,
        sessionId: model.sessionId,
        deviceId: model.deviceId,
        userAgent: model.userAgent,
        ipAddress: model.ipAddress,
        geolocation: mapGeolocation(model.geolocation),
        createdAt: dateToIso(model.createdAt),
        lastActiveAt: dateToIso(model.lastActiveAt),
        expiresAt: dateToIso(model.expiresAt),
        isActive: model.isActive,
        ...mapSoftDeleteToDTO(model),
        ...mapOwnershipToDTO(model),
    };
}

export function userSessionsToDTO(models: IUserSession[]): UserSession[] {
    return models.map(userSessionToDTO);
}

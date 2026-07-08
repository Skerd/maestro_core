import {LoginHistory} from "armonia/src/modules/core/api/user/private/loginHistory/loginHistory.dto";
import {ILoginHistory} from "@coreModule/database/schemas/loginHistory/loginHistory";
import {mapOwnershipToDTO, mapSoftDeleteToDTO} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";
import {mapPopulatedSimpleUser} from "@coreModule/utilities/mappers/common.mapper";

function mapGeolocation(geo: ILoginHistory["geolocation"]): LoginHistory["geolocation"] {
    if (!geo) {
        return {
            ip: "",
            hostname: "",
            city: "",
            region: "",
            country: "",
            loc: "",
            org: "",
            postal: "",
            timezone: "",
        };
    }
    return {
        ip: String(geo.ip ?? ""),
        hostname: String(geo.hostname ?? ""),
        city: String(geo.city ?? ""),
        region: String(geo.region ?? ""),
        country: String(geo.country ?? ""),
        loc: String(geo.loc ?? ""),
        org: String(geo.org ?? ""),
        postal: String(geo.postal ?? ""),
        timezone: String(geo.timezone ?? ""),
    };
}

export function loginHistoryToDTO(model: ILoginHistory): LoginHistory {
    return {
        _id: model._id.toString(),
        user: model.user ? mapPopulatedSimpleUser(model.user) : undefined,
        time: model.time instanceof Date ? model.time.toISOString() : new Date(model.time as unknown as string).toISOString(),
        status: model.status,
        mfa: model.mfa,
        reason: model.reason ?? null,
        device: model.device,
        os: model.os,
        browser: model.browser,
        userAgent: model.userAgent,
        ip: model.ip,
        geolocation: mapGeolocation(model.geolocation),
        createdAt: model.createdAt ? new Date(model.createdAt).toISOString() : undefined,
        updatedAt: model.updatedAt ? new Date(model.updatedAt).toISOString() : undefined,
        ...mapSoftDeleteToDTO(model),
        ...mapOwnershipToDTO(model),
    };
}

export function loginHistoriesToDTO(models: ILoginHistory[]): LoginHistory[] {
    return models.map(loginHistoryToDTO);
}

import {LoginHistory} from "armonia/src/modules/core/api/user/private/loginHistory/loginHistory.dto";
import {ILoginHistory} from "@coreModule/database/schemas/loginHistory/loginHistory";
import {mapLifeCycleToDTO, mapOwnershipToDTO, mapSoftDeleteToDTO} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";
import {mapPopulatedSimpleUser} from "@coreModule/utilities/mappers/common.mapper";

export function loginHistoryToDTO(model: ILoginHistory): LoginHistory {
    return {
        _id: model._id.toString(),
        user: model.user ? mapPopulatedSimpleUser(model.user) : undefined,
        time: model.time,
        status: model.status,
        mfa: model.mfa,
        reason: model.reason ?? null,
        device: model.device,
        os: model.os,
        browser: model.browser,
        userAgent: model.userAgent,
        ip: model.ip,
        geolocation: model.geolocation ? {
            ip: model.geolocation.ip,
            hostname: model.geolocation.hostname,
            city: model.geolocation.city,
            region: model.geolocation.region,
            country: model.geolocation.country,
            loc: model.geolocation.loc,
            org: model.geolocation.org,
            postal: model.geolocation.postal,
            timezone: model.geolocation.timezone,
        } : undefined,
        ...mapSoftDeleteToDTO(model),
        ...mapOwnershipToDTO(model),
        ...mapLifeCycleToDTO(model),
    };
}

export function loginHistoriesToDTO(models: ILoginHistory[]): LoginHistory[] {
    return models.map(loginHistoryToDTO);
}

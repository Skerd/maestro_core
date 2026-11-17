import type {IUserAddress} from "@coreModule/database/schemas/userAddress/userAddress";
import type {UserAddress} from "armonia/src/modules/core/api/user/private/userAddress/userAddress.dto";
import type {CountrySimple} from "armonia/src/modules/core/dto/country.dto";
import type {StateSimple} from "armonia/src/modules/core/dto/state.dto";
import type {CitySimple} from "armonia/src/modules/core/dto/city.dto";
import type {SimpleBlankUser} from "armonia/src/modules/core/dto/user.dto";
import {mapSnippet} from "@coreModule/utilities/mappers/common.mapper";
import {CountrySimpleSnippet} from "@coreModule/database/schemas/country/country.snippets";
import {StateSimpleSnippet} from "@coreModule/database/schemas/state/state.snippets";
import {CitySimpleSnippet} from "@coreModule/database/schemas/city/city.snippets";
import {SimpleBlankUserSnippet} from "@coreModule/database/schemas/user/user.snippets";
import {
    mapLifeCycleToDTO,
    mapOwnershipToDTO,
    mapSoftDeleteToDTO,
} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

export function userAddressToDTO(address: IUserAddress): UserAddress {
    return {
        _id: address._id.toString(),
        user: mapSnippet<SimpleBlankUser>()(address.user, SimpleBlankUserSnippet),
        type: address.type,
        firstName: address.firstName,
        lastName: address.lastName,
        email: address.email,
        phone: address.phone,
        street: address.street,
        city: mapSnippet<CitySimple>()(address.city, CitySimpleSnippet),
        state: mapSnippet<StateSimple>()(address.state, StateSimpleSnippet),
        postalCode: address.postalCode,
        country: mapSnippet<CountrySimple>()(address.country, CountrySimpleSnippet),
        latitude: address.latitude,
        longitude: address.longitude,
        isDefault: address.isDefault,
        label: address.label,
        ...mapSoftDeleteToDTO(address),
        ...mapOwnershipToDTO(address),
        ...mapLifeCycleToDTO(address),
    };
}

export function userAddressesToDTO(addresses: IUserAddress[]): UserAddress[] {
    return addresses.map(userAddressToDTO);
}

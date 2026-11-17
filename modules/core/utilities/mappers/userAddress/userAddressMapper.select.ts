import type {IUserAddress} from "@coreModule/database/schemas/userAddress/userAddress";
import type {ApiSelectDatum} from "armonia/src/modules/core/types/shared.types";

export function userAddressToSelect(address: IUserAddress): ApiSelectDatum {
    return {
        value: address._id.toString(),
        label: `${address.firstName} ${address.lastName} (${address.type === "billing" ? "Billing" : "Shipping"})${address.city?.name ? ` — ${address.city.name}` : ""}`,
    };
}

export function userAddressesToSelect(addresses: IUserAddress[]): ApiSelectDatum[] {
    return addresses.map(userAddressToSelect);
}

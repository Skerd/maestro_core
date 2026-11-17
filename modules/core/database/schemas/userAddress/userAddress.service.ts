import {ObjectId} from "mongodb";
import {BaseCrudService} from "@coreModule/database/services/baseCrudService";
import {findPlatformCompanyId} from "@coreModule/utilities/security/platformAccess";
import UserAddress, {IUserAddress} from "@coreModule/database/schemas/userAddress/userAddress";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";

export class UserAddressService extends BaseCrudService<IUserAddress, typeof UserAddress> {
    constructor() {
        super(UserAddress, "UserAddress");
    }

    /**
     * The address books' rows (D163): stored in the platform company, the person's own when `userIds` names them. Matches
     * nothing while there is no platform company, so no company's leftover rows ever show.
     */
    async bookClause(userIds?: Array<ObjectId | string>): Promise<Record<string, unknown>> {
        const platformId = await findPlatformCompanyId();
        if (!platformId) return {_id: {$exists: false}};
        return {
            company: platformId,
            ...(userIds ? {user: {$in: userIds.map((id) => new ObjectId(String(id)))}} : {}),
        };
    }

    /** The company every address book is stored in: the platform company; refused while the instance has none. */
    async bookCompanyOrThrow(languageCode: string): Promise<ObjectId> {
        const platformId = await findPlatformCompanyId();
        if (!platformId) throw apiValidationException("user_address_book_unavailable", "", null, languageCode);
        return platformId;
    }
}

export const userAddressService = new UserAddressService();

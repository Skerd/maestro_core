import type {HydratedDocument} from "mongoose";
import type {Types} from "mongoose";
import UserAddress, {type IUserAddress} from "./userAddress";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {defaultCompaniesValues} from "@coreModule/database/schemas/company/company.defaults";
import {demoName} from "@coreModule/utilities/helpers";
import type {UserAddressType} from "armonia/src/modules/core/api/user/private/userAddress/userAddress.schema-def";

export const USER_ADDRESS_HOME_LABEL = demoName("Home");
export const USER_ADDRESS_BILLING_LABEL = demoName("Billing");

type UserAddressSeed = {
    type: UserAddressType;
    label: string;
    isDefault: boolean;
};

/**
 * Seeds echo's demo shipping + billing addresses in their address book, which lives in the platform company (D163).
 * Idempotent on `{company, user, label}`.
 * One default may exist per type. City and country are required — skip when geo refs are missing.
 */
export async function createUserAddresses(
    parentLogger: serverLogger,
    company: ICompany,
    userId: Types.ObjectId | undefined,
    geo: {countryId?: Types.ObjectId; stateId?: Types.ObjectId; cityId?: Types.ObjectId},
    addr: typeof defaultCompaniesValues.address,
): Promise<HydratedDocument<IUserAddress>[]> {
    const logger = getLogger("mongoDbInitialization-createUserAddresses", parentLogger);
    logger.start("Creating user addresses...");

    if (!userId) {
        logger.warn("Skipping user address: echo@echo.com was not found.");
        logger.finish("Finished creating user addresses!", 0);
        return [];
    }
    if (!geo.countryId || !geo.cityId) {
        logger.warn("Skipping user address: country or city was not seeded.");
        logger.finish("Finished creating user addresses!", 0);
        return [];
    }

    const seeds: readonly UserAddressSeed[] = [
        {type: "shipping", label: USER_ADDRESS_HOME_LABEL, isDefault: true},
        {type: "billing", label: USER_ADDRESS_BILLING_LABEL, isDefault: true},
    ];

    const created: HydratedDocument<IUserAddress>[] = [];

    try {
        for (const seed of seeds) {
            const payload = {
                user: userId,
                type: seed.type,
                firstName: "echo",
                lastName: "silence",
                email: "echo@echo.com",
                phone: "+355 69 000 0000",
                street: addr.street,
                city: geo.cityId,
                ...(geo.stateId ? {state: geo.stateId} : {}),
                postalCode: addr.postalCode,
                country: geo.countryId,
                latitude: addr.geoLocation.latitude,
                longitude: addr.geoLocation.longitude,
                isDefault: seed.isDefault,
                label: seed.label,
                company: company._id,
                createdBy: company.createdBy,
            };

            let doc = await UserAddress.findOne({
                company: company._id,
                user: userId,
                label: seed.label,
            });
            if (!doc) {
                doc = await UserAddress.create(payload);
            } else {
                doc.set(payload);
                await doc.save();
            }
            created.push(doc);
        }
        logger.finish("Finished creating user addresses!", created.length);
        return created;
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        logger.err(`Error creating user address: ${message}`);
        logger.fail("Failed to create user addresses!");
        return created;
    }
}

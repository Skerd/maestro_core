import {ObjectId} from "mongodb";
import User from "@coreModule/database/schemas/user/user";
import Role from "@coreModule/database/schemas/role/role";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import type {ICompany} from "@coreModule/database/schemas/company/company";

export type DemoSignupUserSeed = {
    username: string;
    name: string;
    surname: string;
    phoneNumber: string;
    birthday: string;
};

/** Shared demo password of core's demo customers. Hashed on save by the User pre-save hook. */
export const CORE_DEMO_CUSTOMER_PASSWORD = "customer";

/** The customers every demo company gets, so its Company → Users list is not empty (TD-B240). */
export const coreDemoCustomerSeeds: readonly DemoSignupUserSeed[] = [
    {username: "arta.hoxha@example.com", name: "Arta", surname: "Hoxha", phoneNumber: "+355691130101", birthday: "1990-06-14"},
    {username: "luca.ferri@example.com", name: "Luca", surname: "Ferri", phoneNumber: "+393401130102", birthday: "1984-11-03"},
    {username: "nina.weber@example.com", name: "Nina", surname: "Weber", phoneNumber: "+41791130103", birthday: "1995-01-27"},
];

function refId(value: unknown): string | undefined {
    if (value == null) return undefined;
    if (value instanceof ObjectId) return value.toString();
    if (typeof value === "object" && "_id" in value) {
        const inner = (value as {_id?: unknown})._id;
        if (inner != null && inner !== value) return refId(inner);
    }
    return String(value);
}

/**
 * Makes demo people members of the company with its signup role: customers, not staff, so they stay off the staff
 * pickers. A person who already belongs to the company keeps their roles; one who exists joins it. Idempotent on
 * username. A new person takes the company's time zone.
 */
export async function createDemoSignupUsers(
    parentLogger: serverLogger | undefined,
    company: Pick<ICompany, "_id" | "name" | "createdBy" | "timezone">,
    seeds: readonly DemoSignupUserSeed[],
    password: string,
): Promise<void> {
    const logger = getLogger("demo_signup_users", parentLogger);
    const companyId = company._id as ObjectId;
    const creatorId = refId(company.createdBy);

    // Loaded here: the time zone helper reads companies through the company service, which loads the Company schema,
    // and the Company schema loads this seed.
    const {companyTimeZone} = await import("@coreModule/utilities/time/companyTimeZone");
    const role = await Role.findOne({company: companyId, isSignupDefault: true}).select("_id name");
    if (!role) {
        logger.warn(`'${company.name}' has no signup role; skipping its demo customers`);
        return;
    }

    for (const seed of seeds) {
        const membership = {
            _id: new ObjectId(),
            active: "active" as const,
            unsuccessfulLogins: 0,
            lockedOutUntil: null,
            lastLogin: null,
            rolesCount: 1,
            roles: [role._id],
            company: companyId,
        };
        const user = await User.findOne({username: seed.username});
        if (user) {
            if (user.roles.some((entry) => refId(entry.company) === companyId.toString())) {
                logger.info(`${seed.username} already belongs to '${company.name}'`);
                continue;
            }
            if (!user.companies.some((entry) => refId(entry) === companyId.toString())) user.companies.push(companyId as never);
            user.roles.push(membership);
            user.$locals = user.$locals || {};
            user.$locals.auditUserId = creatorId ? new ObjectId(creatorId) : user._id;
            await user.save();
            logger.info(`Added ${seed.username} to '${company.name}' as '${role.name}'`);
            continue;
        }

        const userId = new ObjectId();
        const created = new User({
            _id: userId,
            username: seed.username,
            password,
            name: seed.name,
            surname: seed.surname,
            fullName: `${seed.name} ${seed.surname}`,
            timezone: companyTimeZone(company),
            birthday: seed.birthday,
            phoneNumber: seed.phoneNumber,
            isEmailVerified: true,
            registeredFrom: creatorId ? new ObjectId(creatorId) : userId,
            mfaStatus: "notActive",
            online: false,
            isBot: false,
            companies: [companyId],
            roles: [membership],
        });
        created.$locals = created.$locals || {};
        created.$locals.auditUserId = creatorId ? new ObjectId(creatorId) : userId;
        await created.save();
        logger.info(`Created ${seed.username} as '${role.name}'`);
    }
}

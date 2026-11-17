import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {createSmtpServers} from "@coreModule/database/schemas/smtpServer/smtpServer.defaults";
import SmtpServer from "@coreModule/database/schemas/smtpServer/smtpServer";
import MessagingProvider from "@coreModule/database/schemas/messagingProvider/messagingProvider";
import {mayUsePlatformOnly} from "@coreModule/database/plugins/platformOnlyPlugin";
import {createMessagingProviders} from "@coreModule/database/schemas/messagingProvider/messagingProvider.defaults";
import {createChannels} from "@coreModule/database/schemas/channel/channel.defaults";
import {createMessages} from "@coreModule/database/schemas/message/message.defaults";
import {createNotifications} from "@coreModule/database/schemas/notification/notification.defaults";
import {createMedia} from "@coreModule/database/schemas/media/media.defaults";
import {createUserAddresses} from "@coreModule/database/schemas/userAddress/userAddress.defaults";
import {CORE_DEMO_CUSTOMER_PASSWORD, coreDemoCustomerSeeds, createDemoSignupUsers} from "@coreModule/database/demo/demoSignupUsers";
import User from "@coreModule/database/schemas/user/user";
import Country from "@coreModule/database/schemas/country/country";
import State from "@coreModule/database/schemas/state/state";
import City from "@coreModule/database/schemas/city/city";

/**
 * Core company demo rows that `runModuleCompanyDemoSeeds` cannot discover
 * (it skips the `core` module). Called from `Company.addCompanyDemoData`
 * after geo/currency seeds and before feature-module seeds.
 *
 * Cron jobs are seeded by `seedPlatformJobs.ts` on the cron server, not here.
 */
export async function seedCoreDemoData(
    parentLogger: serverLogger | undefined,
    company: ICompany,
): Promise<void> {
    const logger = getLogger("core_company_demo_seed", parentLogger);
    logger.start("Seeding core demo data...");

    // Mail servers and messaging providers are the platform's (D161); a company may keep its own when one of its
    // modules registered for them (`moduleBootstrap.platformOnlyUses`).
    if (mayUsePlatformOnly(SmtpServer, company, company.modules)) await createSmtpServers(logger, company);
    if (mayUsePlatformOnly(MessagingProvider, company, company.modules)) await createMessagingProviders(logger, company);
    await createChannels(logger, company);
    await createMessages(logger, company);
    await createNotifications(logger, company);
    await createMedia(logger, company);
    await createDemoSignupUsers(logger, company, coreDemoCustomerSeeds, CORE_DEMO_CUSTOMER_PASSWORD);
    // A person's address book lives in the platform company (D163), so echo's is seeded there.
    if (company.isPlatformOwner) await seedDemoAddressBook(logger, company);

    logger.finish("Finished seeding core demo data!");
}

async function seedDemoAddressBook(logger: serverLogger, company: ICompany): Promise<void> {
    // Loaded here: the company defaults import the initializer, which the Company schema (this demo's caller) must not load.
    const {defaultCompaniesValues} = await import("@coreModule/database/schemas/company/company.defaults");
    const demoUser = await User.findOne({username: "echo@echo.com"}).select("_id").lean();
    const addr = defaultCompaniesValues.address;
    const country = await Country.findOne({code: addr.countryCode}).select("_id").lean();
    const state = country ? await State.findOne({country: country._id, code: addr.stateCode}).select("_id").lean() : null;
    const city = country ? await City.findOne({country: country._id, name: addr.cityName}).select("_id").lean() : null;
    await createUserAddresses(logger, company, demoUser?._id, {
        countryId: country?._id,
        stateId: state?._id,
        cityId: city?._id,
    }, addr);
}

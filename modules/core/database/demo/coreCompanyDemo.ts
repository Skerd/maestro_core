import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {createSmtpServers} from "@coreModule/database/schemas/smtpServer/smtpServer.defaults";
import {createMessagingProviders} from "@coreModule/database/schemas/messagingProvider/messagingProvider.defaults";
import {createChannels} from "@coreModule/database/schemas/channel/channel.defaults";
import {createMessages} from "@coreModule/database/schemas/message/message.defaults";
import {createNotifications} from "@coreModule/database/schemas/notification/notification.defaults";
import {createMedia} from "@coreModule/database/schemas/media/media.defaults";

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

    await createSmtpServers(logger, company);
    await createMessagingProviders(logger, company);
    await createChannels(logger, company);
    await createMessages(logger, company);
    await createNotifications(logger, company);
    await createMedia(logger, company);

    logger.finish("Finished seeding core demo data!");
}

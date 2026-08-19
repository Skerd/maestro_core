import MessagingProvider from "./messagingProvider";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICompany} from "@coreModule/database/schemas/company/company";

/**
 * Inactive Twilio placeholder so the messaging-provider screen has a row.
 *
 * `authTokenEncrypted` is omitted — never seed live tokens. `accountSid` is an
 * obvious fake. `active: false` so nothing tries to send through it.
 */
export async function createMessagingProviders(
    parentLogger: serverLogger,
    company: ICompany,
): Promise<void> {
    const logger = getLogger("mongoDbInitialization-createMessagingProviders", parentLogger);
    logger.start("Creating messaging provider placeholders...");

    try {
        const payload = {
            name: "Demo Twilio (inactive)",
            providerType: "twilio",
            accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            fromPhone: "+15555550100",
            fromWhatsapp: "+15555550100",
            active: false,
            company: company._id,
            createdBy: company.createdBy,
        };

        const existing = await MessagingProvider.findOne({company: company._id, name: payload.name});
        if (existing) {
            existing.set(payload);
            await existing.save();
        } else {
            await MessagingProvider.create(payload);
        }

        logger.finish("Finished creating messaging provider placeholders!", 1);
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        logger.err(`Error creating messaging provider placeholder: ${message}`);
        logger.fail("Failed to create messaging provider placeholders!");
    }
}

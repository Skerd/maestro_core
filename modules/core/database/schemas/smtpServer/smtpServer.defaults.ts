import SmtpServer from "./smtpServer";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICompany} from "@coreModule/database/schemas/company/company";

/**
 * Inactive SMTP placeholder so the mail settings screen is not empty.
 *
 * `passwordEncrypted` is deliberately omitted — never seed live credentials.
 * `active: false` so nothing tries to send through it.
 */
export async function createSmtpServers(
    parentLogger: serverLogger,
    company: ICompany,
): Promise<void> {
    const logger = getLogger("mongoDbInitialization-createSmtpServers", parentLogger);
    logger.start("Creating SMTP server placeholders...");

    try {
        const payload = {
            name: "Demo SMTP (inactive)",
            sequence: 10,
            active: false,
            host: "smtp.example.test",
            port: 587,
            encryption: "starttls" as const,
            authType: "login" as const,
            username: "noreply@example.test",
            fromEmail: "noreply@example.test",
            fromName: "Pronix Demo",
            company: company._id,
            createdBy: company.createdBy,
        };

        const existing = await SmtpServer.findOne({company: company._id, name: payload.name});
        if (existing) {
            existing.set(payload);
            await existing.save();
        } else {
            await SmtpServer.create(payload);
        }

        logger.finish("Finished creating SMTP server placeholders!", 1);
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        logger.err(`Error creating SMTP server placeholder: ${message}`);
        logger.fail("Failed to create SMTP server placeholders!");
    }
}

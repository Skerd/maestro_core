import Message from "./message";
import Channel from "@coreModule/database/schemas/channel/channel";
import User from "@coreModule/database/schemas/user/user";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {CORE_DEMO_CHANNEL_NAME} from "@coreModule/database/schemas/channel/channel.defaults";
import {DecryptStringSafe, EncryptString} from "@coreModule/utilities/security/encryption";

const DEMO_MESSAGES: readonly {from: string; to: string; text: string}[] = [
    {
        from: "echo@echo.com",
        to: "almir@leka.com",
        text: "Welcome to the Pronix ops channel.\n\n[core-demo-seed:msg-01]",
    },
    {
        from: "almir@leka.com",
        to: "echo@echo.com",
        text: "Gift-card order DEMO-ORD-1008 landed — finance should issue the card.\n\n[core-demo-seed:msg-02]",
    },
    {
        from: "skerd@xhafa.com",
        to: "echo@echo.com",
        text: "POS till in Tirana is closed for the day.\n\n[core-demo-seed:msg-03]",
    },
];

function storedTextContainsMarker(stored: string | undefined, marker: string): boolean {
    if (!stored) {
        return false;
    }
    return DecryptStringSafe(stored).includes(marker);
}

/**
 * A handful of staff messages in the demo ops channel. Idempotent on the
 * `[core-demo-seed:msg-N]` marker in decrypted `text`.
 */
export async function createMessages(
    parentLogger: serverLogger,
    company: ICompany,
): Promise<void> {
    const logger = getLogger("mongoDbInitialization-createMessages", parentLogger);
    logger.start("Creating demo chat messages...");

    try {
        const channel = await Channel.findOne({company: company._id, name: CORE_DEMO_CHANNEL_NAME}).select("_id");
        if (!channel) {
            logger.warn("Skipping demo messages: ops channel was not seeded.");
            logger.finish("Finished creating demo chat messages!", 0);
            return;
        }

        const channelMessages = await Message.find({channel: channel._id}).select("_id text");
        let created = 0;
        for (const row of DEMO_MESSAGES) {
            const sender = await User.findOne({username: row.from}).select("_id");
            const receiver = await User.findOne({username: row.to}).select("_id");
            if (!sender || !receiver) {
                logger.warn(`Skipping message: user "${row.from}" or "${row.to}" not found.`);
                continue;
            }

            const marker = row.text.match(/\[core-demo-seed:msg-\d+\]/)?.[0];
            const existing = marker
                ? channelMessages.find((message) => storedTextContainsMarker(message.text, marker))
                : undefined;

            const payload = {
                channel: channel._id,
                sender: sender._id,
                receiver: receiver._id,
                text: EncryptString(row.text),
                type: "message" as const,
                status: "active" as const,
                company: company._id,
                createdBy: sender._id,
            };

            if (existing) {
                existing.set(payload);
                await existing.save();
            } else {
                await Message.create(payload);
            }
            created += 1;
        }

        logger.finish("Finished creating demo chat messages!", created);
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        logger.err(`Error creating demo messages: ${message}`);
        logger.fail("Failed to create demo chat messages!");
    }
}

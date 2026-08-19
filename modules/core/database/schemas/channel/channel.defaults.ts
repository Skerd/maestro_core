import Channel, {type IChannel} from "./channel";
import User from "@coreModule/database/schemas/user/user";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {defaultSysUsers} from "@coreModule/database/schemas/user/user.defaults";
import type {HydratedDocument} from "mongoose";

export const CORE_DEMO_CHANNEL_NAME = "core-demo-seed:ops-chat";

/**
 * One group channel for the demo staff so chat, messages and notifications
 * have somewhere to hang off. Idempotent on `{company, name}`.
 */
export async function createChannels(
    parentLogger: serverLogger,
    company: ICompany,
): Promise<HydratedDocument<IChannel> | null> {
    const logger = getLogger("mongoDbInitialization-createChannels", parentLogger);
    logger.start("Creating demo chat channels...");

    try {
        const usernames = defaultSysUsers.map((u: {username: string}) => u.username);
        const users = await User.find({username: {$in: usernames}}).select("_id username");
        if (users.length < 2) {
            logger.warn("Skipping demo channel: fewer than two demo users found.");
            logger.finish("Finished creating demo chat channels!", 0);
            return null;
        }

        const owner = users.find((u) => u.username === "echo@echo.com") ?? users[0];
        const payload = {
            name: CORE_DEMO_CHANNEL_NAME,
            description: "Internal Pronix ops chat (demo).",
            users: users.map((u) => u._id),
            owner: owner._id,
            adminUsers: [owner._id],
            isGroup: true,
            isAiAssistant: false,
            isPublicChat: false,
            lastAction: new Date(),
            company: company._id,
            createdBy: owner._id,
        };

        let existing = await Channel.findOne({company: company._id, name: CORE_DEMO_CHANNEL_NAME});
        if (existing) {
            existing.set(payload);
            await existing.save();
        } else {
            existing = await Channel.create(payload);
        }

        logger.finish("Finished creating demo chat channels!", 1);
        return existing;
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        logger.err(`Error creating demo channel: ${message}`);
        logger.fail("Failed to create demo chat channels!");
        return null;
    }
}

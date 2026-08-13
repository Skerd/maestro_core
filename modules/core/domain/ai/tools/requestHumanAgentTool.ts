/**
 * `request_human_agent` — lets the bot hand a visitor over to a person.
 *
 * The most valuable tool in the public set: a bot that knows when to stop is
 * worth more than one that guesses. The model calls this when the visitor asks
 * for a human, when the question needs commercial judgement (negotiating a
 * price, arranging a viewing, anything about an existing contract), or when it
 * simply cannot answer from the other tools.
 *
 * PUBLIC-ONLY. Internal company users are already talking to their colleagues;
 * there is nobody to escalate an internal assistant chat to.
 *
 * The tool acts on the conversation named by {@link AssistantToolContext.channelId} —
 * never on a channel id the model supplies — so it cannot escalate someone
 * else's chat.
 *
 * @module requestHumanAgentTool
 */

import {ObjectId} from "mongodb";
import {z} from "zod";
import {registerAssistantTool} from "@coreModule/domain/ai/tools/toolRegistry";
import type {AssistantTool, AssistantToolContext} from "@coreModule/domain/ai/tools/assistantTool.types";
import {channelService} from "@coreModule/database/schemas/channel/channel.service";
import {requestHumanHandoff} from "@coreModule/domain/publicChat/handoff";

const RequestHumanAgentArgs = z
    .object({
        reason: z.string().trim().min(1).max(500).optional(),
    })
    .strip();

const parameters = {
    type: "object" as const,
    properties: {
        reason: {
            type: "string",
            description:
                "A short note for the colleague picking this up, e.g. \"visitor wants to " +
                "arrange a viewing for unit A-102\" or \"asked about payment terms\".",
        },
    },
    required: [] as string[],
};

async function execute(rawArgs: unknown, ctx: AssistantToolContext): Promise<unknown> {
    const args = RequestHumanAgentArgs.parse(rawArgs ?? {});

    // The channel comes from the trusted context, never from the model.
    const channel = await channelService.findOne(
        {
            _id: new ObjectId(ctx.channelId),
            company: new ObjectId(ctx.companyId),
            isPublicChat: true,
        },
        {logger: ctx.logger, languageCode: ctx.languageCode},
    );

    if (!channel) {
        return {requested: false, reason: "This conversation cannot be transferred."};
    }

    const escalated = await requestHumanHandoff({
        channel,
        companyId: new ObjectId(ctx.companyId),
        visitorId: new ObjectId(ctx.userId),
        reason: args.reason,
        languageCode: ctx.languageCode,
        logger: ctx.logger,
    });

    // Tell the model what actually happened so it does not promise a second time.
    return escalated
        ? {
            requested: true,
            message:
                "A colleague has been notified and will join this conversation. " +
                "Tell the visitor someone is coming and offer to keep helping meanwhile.",
        }
        : {
            requested: false,
            alreadyPending: true,
            message: "A colleague has already been asked to join this conversation.",
        };
}

export const requestHumanAgentTool: AssistantTool = {
    name: "request_human_agent",
    audience: "public",
    description:
        "Ask a member of the company's team to join this conversation. Use this when " +
        "the visitor asks to speak to a person, when they want to arrange a viewing or " +
        "discuss prices, terms or an existing agreement, or when you cannot answer their " +
        "question with the other tools. Call it once — repeating it does nothing.",
    parameters,
    execute,
};

/** Registered by the core tool bootstrap (registerAllAssistantTools). */
export function registerPublicChatAssistantTools(): void {
    registerAssistantTool(requestHumanAgentTool);
}

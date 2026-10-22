/**
 * Graceful shutdown of the shared infrastructure connections.
 *
 * Each server's shutdown runs its own cleanup first (heartbeats, scheduler,
 * Telegram poller lock, uptime row — all of which still need Redis/MongoDB),
 * then calls {@link closeConnections}, then exits. The connection modules
 * register no signal handlers of their own, so nothing exits mid-cleanup.
 *
 * @module closeConnections
 */

import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {disconnectFromWebSocketServer} from "@coreModule/connections/connectToWebSocketServer";
import {disconnectFromKafka} from "@coreModule/connections/connectToKafka";
import {disconnectFromRedis} from "@coreModule/connections/connectToRedis";
import {disconnectFromMongoDb} from "@coreModule/connections/connectToMongoDb";

/** Upper bound per connection, so one hung close cannot block the exit. */
const CLOSE_STEP_TIMEOUT_MS = 5_000;

/**
 * Closes the WebSocket client, Kafka, Redis and MongoDB, in that order: Kafka
 * consumers may still write to Redis/MongoDB while they leave their groups.
 * Every step is attempted even when an earlier one fails or times out;
 * connections this process never opened are skipped by their own disconnect.
 */
export async function closeConnections(parentLogger?: serverLogger): Promise<void> {
    const logger = getLogger("closing_connections", parentLogger);
    const steps: [string, () => Promise<void>][] = [
        ["WebSocket", disconnectFromWebSocketServer],
        ["Kafka", disconnectFromKafka],
        ["Redis", disconnectFromRedis],
        ["MongoDB", disconnectFromMongoDb],
    ];

    for (const [name, close] of steps) {
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                close(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`timed out after ${CLOSE_STEP_TIMEOUT_MS} ms`)), CLOSE_STEP_TIMEOUT_MS);
                }),
            ]);
            logger.debug(`${name} connection closed`);
        } catch (error: any) {
            logger.err(`Closing ${name} connection failed: ${error?.message ?? error}`);
        } finally {
            clearTimeout(timer);
        }
    }
}

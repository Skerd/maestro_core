import mongoose from "mongoose";
import {MONGO_DB} from "@coreModule/environment";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";
import {MongoDbHealth} from "armonia/src/modules/core/api/auxiliary/private/serverHealth/serverHealth.dto";
import {initializeMongoDatabase} from "@initializer";

export const mongooseInstance = mongoose;

mongooseInstance.set('strictQuery', true);

const MAX_CONNECT_ATTEMPTS = 300;

/** Connection lifecycle handlers are registered once per process. */
let handlersSetup = false;

/** Full connection string, credentials and TLS files included. Never log it. */
function buildMongoUri(): string {
    const port = MONGO_DB.PORT !== "" ? (":" + MONGO_DB.PORT) : "";
    return `${MONGO_DB.PRE_HOST + MONGO_DB.USER}:${MONGO_DB.PASSWORD}@${MONGO_DB.HOST + port}/${MONGO_DB.DB_NAME + MONGO_DB.PARAMS}&tlsCAFile=${MONGO_DB.ROOT_CA_CERT_PATH}&tlsCertificateKeyFile=${MONGO_DB.TLS_CERTIFICATE_KEY_FILE_PATH}`;
}

/**
 * Connects mongoose, retrying until MongoDB answers (exits the process after
 * {@link MAX_CONNECT_ATTEMPTS}). After the first connection the driver itself
 * reconnects on network loss, so the lifecycle handlers below only log.
 */
export async function connectToMongoDb(parentLogger?: serverLogger, canInitialize?: boolean): Promise<void> {

    let logger = getLogger("connecting_to_mongo_db_instance", parentLogger);
    logger.start("Setting up MongoDB instance");
    logger.debug(`MongoDB target host=${MONGO_DB.HOST}, port=${MONGO_DB.PORT}, db=${MONGO_DB.DB_NAME}, user=${MONGO_DB.USER ? 'provided' : 'not provided'}`);

    const connectWithRetry = async (): Promise<void> => {
        let attempt = 0;
        while (true) {
            try {
                logger.debug(`Attempting MongoDB connection [${attempt + 1}/${MAX_CONNECT_ATTEMPTS}]...`);
                await mongoose.connect(buildMongoUri());
                logger.info('MongoDB connected');
                void uptimeKeeper.markStart("mongoDb");
                return;
            } catch (error) {
                attempt++;
                logger.err(`MongoDB connection failed: ${error.message}. Retrying in ${MONGO_DB.CONNECTION_TIMER} ms.`);
                if (attempt >= MAX_CONNECT_ATTEMPTS) {
                    logger.fail('Exceeded MongoDB retry limit. Exiting...');
                    process.exit(1);
                }
                await new Promise(res => setTimeout(res, MONGO_DB.CONNECTION_TIMER));
            }
        }
    };

    if (!handlersSetup) {
        mongooseInstance.connection.on('connected', () => {
            logger.info(`MongoDB connected successfully. ReadyState: [${mongooseInstance.connection.readyState}]`);
        });
        mongooseInstance.connection.on('error', (error) => {
            logger.err(`MongoDB connection error. Message: ${error.message}. ReadyState: [${mongooseInstance.connection.readyState}]`);
        });
        mongooseInstance.connection.on('disconnected', () => {
            logger.warn(`MongoDB disconnected. ReadyState: [${mongooseInstance.connection.readyState}]. The driver reconnects automatically.`);
        });
        mongooseInstance.connection.on('reconnected', () => {
            logger.info(`MongoDB reconnected. ReadyState: [${mongooseInstance.connection.readyState}]`);
        });
        handlersSetup = true;
    }

    await connectWithRetry();

    if( !!canInitialize ){
        await initializeMongoDatabase(parentLogger);
    }

    logger.finish("Finished setting up MongoDB instance");
}

/**
 * Closes the mongoose connection. Called by each server's graceful shutdown.
 */
export async function disconnectFromMongoDb(): Promise<void> {
    await mongoose.disconnect();
}

/**
 * Returns the current MongoDB connection state and lightweight pool/storage stats.
 *
 * Used by the public `/auxiliary/health` endpoint and the WS broadcaster.
 *
 * Notes:
 *  - `dbSize`, `storageSize`, `indexSize` come from `db.stats()`. We swallow errors and
 *    return zero on failure so a slow stats call never breaks the health response.
 *  - Pool stats come from the underlying MongoDB topology when available; otherwise
 *    they are reported as zero. This is purely informational.
 *  - `lastStart` is sourced from the shared `UptimeKeeper` so it survives process restarts.
 */
export async function getMongoDbHealth(): Promise<MongoDbHealth> {

    const conn = mongooseInstance.connection;
    const readyState = conn?.readyState ?? 0;
    const connected = readyState === 1;

    let dbSize = 0;
    let storageSize = 0;
    let indexSize = 0;
    if (connected && conn?.db) {
        try {
            const stats: any = await conn.db.stats();
            dbSize = Number(stats?.dataSize ?? 0);
            storageSize = Number(stats?.storageSize ?? 0);
            indexSize = Number(stats?.indexSize ?? 0);
        }
        catch {
            // Stats are non-essential; ignore failures.
        }
    }

    let maxPoolSize = 0;
    let minPoolSize = 0;
    let currentConnections = 0;
    let availableConnections = 0;
    try {
        const client: any = (conn as any)?.getClient?.();
        const topology: any = client?.topology;
        const opts: any = client?.s?.options || conn?.config;
        if (opts) {
            maxPoolSize = Number(opts?.maxPoolSize ?? 0);
            minPoolSize = Number(opts?.minPoolSize ?? 0);
        }
        const description: any = topology?.description;
        if (description?.servers && typeof description.servers.values === "function") {
            for (const srv of description.servers.values() as any) {
                currentConnections += Number(srv?.currentConnectionCount ?? 0);
                availableConnections += Number(srv?.availableConnectionCount ?? 0);
            }
        }
    }
    catch {
        // Pool stats are best-effort.
    }

    return {
        lastStart: uptimeKeeper.getLastStart("mongoDb"),
        connected,
        readyState,
        host: conn?.host || "",
        name: conn?.name || "",
        dbSize,
        storageSize,
        indexSize,
        poolStats: {
            maxPoolSize,
            minPoolSize,
            currentConnections,
            availableConnections,
            utilizationPercent: maxPoolSize === 0 ? 0 : Math.round((currentConnections / maxPoolSize) * 100),
            waitingRequests: 0
        }
    };
}

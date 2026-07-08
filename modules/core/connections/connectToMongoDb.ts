import mongoose, {Mongoose} from "mongoose";
import {MONGO_DB} from "@coreModule/environment";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {mongoDbCircuitBreaker} from "@coreModule/utilities/circuitBreaker";
import {uptimeKeeper} from "@coreModule/utilities/uptime/uptimeKeeper";
import {MongoDbHealth} from "armonia/src/modules/core/api/auxiliary/private/serverHealth/serverHealth.dto";
import {initializeMongoDatabase} from "@initializer";

export const mongooseInstance = require("mongoose");

mongooseInstance.set('strictQuery', true);
let retryCount = 0;
let firstConnection = true;

export async function connectToMongoDb(parentLogger?: serverLogger, canInitialize?: boolean): Promise<void> {

    let logger = getLogger("connecting_to_mongo_db_instance", parentLogger);
    logger.start("Setting up MongoDB instance");
    logger.debug(`${MONGO_DB.PRE_HOST + MONGO_DB.USER}:${MONGO_DB.PASSWORD}@${MONGO_DB.HOST + (MONGO_DB.PORT !== "" ? (":" + MONGO_DB.PORT) : "")}/${MONGO_DB.DB_NAME + MONGO_DB.PARAMS}&tlsCAFile=${MONGO_DB.ROOT_CA_CERT_PATH}&tlsCertificateKeyFile=${MONGO_DB.TLS_CERTIFICATE_KEY_FILE_PATH}`);

    const connectWithRetry = async (): Promise<Mongoose> => {
        let currentRetryCount = 0;
        while (true) {
            try {
                logger.debug(`Attempting MongoDB connection [${currentRetryCount + 1}/${300}]...`);
                const instance = await mongoose.connect(`${MONGO_DB.PRE_HOST + MONGO_DB.USER}:${MONGO_DB.PASSWORD}@${MONGO_DB.HOST + (MONGO_DB.PORT !== "" ? (":" + MONGO_DB.PORT) : "")}/${MONGO_DB.DB_NAME + MONGO_DB.PARAMS}&tlsCAFile=${MONGO_DB.ROOT_CA_CERT_PATH}&tlsCertificateKeyFile=${MONGO_DB.TLS_CERTIFICATE_KEY_FILE_PATH}`);
                logger.info('MongoDB connected');
                retryCount = 0;
                void uptimeKeeper.markStart("mongoDb");
                return instance;
            } catch (error) {
                currentRetryCount++;
                retryCount = currentRetryCount;
                logger.err(`MongoDB connection failed: ${error.message}. Retrying in ${MONGO_DB.CONNECTION_TIMER} ms.`);
                if (currentRetryCount >= 300) {
                    logger.fail('Exceeded MongoDB retry limit. Exiting...');
                    process.exit(1);
                }
                await new Promise(res => setTimeout(res, MONGO_DB.CONNECTION_TIMER));
            }
        }
    };

    logger.debug("Setting up onConnected handler");
    mongooseInstance.connection.on('connected', () => {
        retryCount = 0;
        logger.info(`MongoDB connected successfully. ReadyState: [${mongooseInstance.connection.readyState}]`);
    });
    logger.debug("Finished setting up onConnected handler");

    logger.debug("Setting up onError handler");
    mongooseInstance.connection.on('error', (error) => {
        logger.err(`MongoDB connection error. Message: ${error.message}. ReadyState: [${mongooseInstance.connection.readyState}]`);
    });
    logger.debug("Finished setting up onError handler");

    logger.debug("Setting up onDisconnected handler");
    mongooseInstance.connection.on('disconnected', async (ee: any) => {
        if( !firstConnection ) {
            retryCount++;
            logger.warn(`MongoDB disconnected. ReadyState: [${mongooseInstance.connection.readyState}]. Retrying in ${MONGO_DB.CONNECTION_TIMER} ms. This connection CANNOT FAIL.`);
            if (retryCount >= 300) {
                logger.fail('Exceeded MongoDB retry limit. Exiting...');
                process.exit(1);
            }
            await new Promise((res) => {setTimeout(() => {res(true);}, MONGO_DB.CONNECTION_TIMER)});
            try{
                await mongoose.connect(`${MONGO_DB.PRE_HOST + MONGO_DB.USER}:${MONGO_DB.PASSWORD}@${MONGO_DB.HOST + (MONGO_DB.PORT !== "" ? (":" + MONGO_DB.PORT) : "")}/${MONGO_DB.DB_NAME + MONGO_DB.PARAMS}`);
            }catch(err){
                logger.err(`MongoDB connection error. Error: ${err.message}`);
            }
        }
    });
    logger.debug("Finished setting up onDisconnected handler");

    logger.debug("Setting up onReconnected handler");
    mongooseInstance.connection.on('reconnected', () => {
        logger.info(`MongoDB reconnected. ReadyState: [${mongooseInstance.connection.readyState}]`);
    });
    logger.debug("Finished setting up onReconnected handler");

    logger.debug("Setting up SIGINT handler");
    process.on('SIGINT', async () => {
        logger.info('Received SIGINT, closing database connection...');
        try {
            await mongoose.disconnect();
            logger.info('Database connection closed successfully');
        }
        catch (error) {
            logger.err('Error closing database connection');
        }
        process.exit(0);
    });
    logger.debug("Finished setting up SIGINT handler");

    logger.debug("Setting up SIGTERM handler");
    process.on('SIGTERM', async () => {
        logger.info('Received SIGTERM, closing database connection...');
        try {
            await mongoose.disconnect();
            logger.info('Database connection closed successfully');
        }
        catch (error) {
            logger.err('Error closing database connection');
        }
        process.exit(0);
    });
    logger.debug("Finished setting up SIGTERM handler");

    await connectWithRetry();
    firstConnection = false;

    if( !!canInitialize ){
        await initializeMongoDatabase(parentLogger);
    }

    logger.finish("Finished setting up MongoDB instance");
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
    const circuitBreakerStats = mongoDbCircuitBreaker.getStats();

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
        },
        circuitBreaker: circuitBreakerStats
    };
}

/**
 * Convenience boolean for callers that only need a connectedness check.
 */
export function isMongoDbConnected(): boolean { 
    return mongooseInstance.connection?.readyState === 1;
}
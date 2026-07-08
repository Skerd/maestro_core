/**
 * Kafka Consumer Bootstrap
 *
 * Discovers and starts Kafka consumers from all modules.
 * Each module may export consumer startup under `{module}/kafka/`.
 */

import path from "path";
import fs from "fs";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {isModuleEnabled} from "@coreModule/utilities/modules/enabledModules";

const START_FN_PATTERN = /^start.*KafkaConsumers?$/i;
const BOOTSTRAP_FILENAME = "startAllKafkaConsumers.ts";

type KafkaConsumerStarter = (parentLogger?: serverLogger) => void | Promise<void>;

function isConsumerSourceFile(filename: string): boolean {
    return filename.endsWith(".ts") && !filename.endsWith(".d.ts") && filename !== BOOTSTRAP_FILENAME;
}

function findStartFunctions(moduleExports: Record<string, unknown>): Array<{name: string; fn: KafkaConsumerStarter}> {
    const fns: Array<{name: string; fn: KafkaConsumerStarter}> = [];

    for (const [name, value] of Object.entries(moduleExports)) {
        if (name === "startAllKafkaConsumers") {
            continue;
        }
        if (typeof value === "function" && START_FN_PATTERN.test(name)) {
            fns.push({name, fn: value as KafkaConsumerStarter});
        }
    }

    return fns;
}

/**
 * Scan all modules and start every exported Kafka consumer group found under
 * `{module}/kafka/`. Each starter runs in its own try/catch so one failing
 * module cannot prevent the others from starting.
 */
export async function startAllKafkaConsumers(parentLogger?: serverLogger): Promise<void> {
    const logger = getLogger("kafka_consumers", parentLogger);
    logger.start("Starting Kafka consumers...");

    const modulesPath = path.resolve(__dirname, "../..");
    if (!fs.existsSync(modulesPath)) {
        logger.err(`Modules directory does not exist: ${modulesPath}`);
        logger.finish("Finished starting Kafka consumers!");
        return;
    }

    const moduleEntries = fs.readdirSync(modulesPath, {withFileTypes: true});
    const moduleDirs = moduleEntries.filter(entry => entry.isDirectory() && !entry.name.startsWith("."));
    let starterCount = 0;

    for (const moduleEntry of moduleDirs) {
        if (!isModuleEnabled(moduleEntry.name)) {
            continue;
        }
        const kafkaDir = path.join(modulesPath, moduleEntry.name, "kafka");
        let kafkaStat: fs.Stats | undefined;

        try {
            kafkaStat = fs.statSync(kafkaDir);
        } catch {
            kafkaStat = undefined;
        }

        if (!kafkaStat?.isDirectory()) {
            continue;
        }

        logger.updateSpace(1);
        logger.debug(`Discovering Kafka consumers for [${moduleEntry.name}/kafka]...`);

        const files = fs.readdirSync(kafkaDir, {withFileTypes: true});
        for (const file of files) {
            if (!file.isFile() || !isConsumerSourceFile(file.name)) {
                continue;
            }

            const filePath = path.join(kafkaDir, file.name);
            const importPath = filePath.replace(/\.ts$/, "");

            try {
                const consumerModule = await import(importPath);
                const startFns = findStartFunctions(consumerModule);

                if (startFns.length === 0) {
                    logger.debug(`Skipping ${filePath} — no Kafka consumer start export.`);
                    continue;
                }

                for (const {name, fn} of startFns) {
                    try {
                        await fn(parentLogger);
                        starterCount += 1;
                        logger.debug(`Started ${name} from ${filePath}`);
                    } catch (err: any) {
                        logger.err(`${name} from ${filePath} failed to start: ${err?.message}`);
                    }
                }
            } catch (error: any) {
                logger.err(`Failed to load Kafka consumers from ${filePath}`, error);
            }
        }

        logger.updateSpace(-1);
    }

    logger.finish(`Started ${starterCount} Kafka consumer group${starterCount !== 1 ? "s" : ""}!`);
}

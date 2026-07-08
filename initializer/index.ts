import mongoose, {Model} from "mongoose";
import Currency from "@coreModule/database/schemas/currency/currency";
import Role from "@coreModule/database/schemas/role/role";
import User from "@coreModule/database/schemas/user/user";
import Finance from "@coreModule/database/schemas/finance/finance";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import Channel from "@coreModule/database/schemas/channel/channel";
import LastChannelReadMessage from "@coreModule/database/schemas/lastChannelReadMessage/lastChannelReadMessage";
import Message from "@coreModule/database/schemas/message/message";
import Company from "@coreModule/database/schemas/company/company";
import Transaction from "@coreModule/database/schemas/transaction/transaction";
import Country from "@coreModule/database/schemas/country/country";
import State from "@coreModule/database/schemas/state/state";
import City from "@coreModule/database/schemas/city/city";
import RolePermission from "@coreModule/database/schemas/rolePermission/rolePermission";
import {MONGO_DB} from "@coreModule/environment";
import UserSession from "@coreModule/database/schemas/userSession/userSession";
import LoginHistory from "@coreModule/database/schemas/loginHistory/loginHistory";
import Notification from "@coreModule/database/schemas/notification/notification";
import Media from "@coreModule/database/schemas/media/media";
import AuditLog from "@coreModule/database/schemas/auditLog/auditLog";
import {createRolePermissions} from "@coreModule/database/schemas/rolePermission/rolePermission.default";
import ApiAccess from "@coreModule/database/schemas/apiAccess/apiAccess";
import "@coreModule/database/schemas/smtpServer/smtpServer";
import "@coreModule/database/schemas/messagingProvider/messagingProvider";
import "@coreModule/database/schemas/cronJob/cronJob";
import MessagingProvider from "@coreModule/database/schemas/messagingProvider/messagingProvider";
import {getEnabledModuleNames, isModuleEnabled} from "@coreModule/utilities/modules/enabledModules";
import {createUsers} from "@coreModule/database/schemas/user/user.defaults";
import {createCompanies} from "@coreModule/database/schemas/company/company.defaults";

export {defaultCompaniesValues} from "@coreModule/database/schemas/company/company.defaults";
export {defaultRoles} from "@coreModule/database/schemas/role/role.defaults";
export {defaultSysUsers} from "@coreModule/database/schemas/user/user.defaults";

type ModuleBootstrap = {
    models?: Model<any>[];
    dropModuleCollections?: () => Promise<void>;
};

const coreModels: Model<any>[] = [
    Company,
    Currency,
    Role,
    User,
    UserSession,
    LoginHistory,
    Finance,
    Channel,
    AuditLog,
    LastChannelReadMessage,
    Message,
    Transaction,
    RolePermission,
    Media,
    ApiAccess,
    Notification,
    Country,
    State,
    City,
    MessagingProvider,
];

const OPTIONAL_MODULE_BOOTSTRAPS: Record<string, () => Promise<ModuleBootstrap>> = {
    propertyManagement: () => import("../modules/propertyManagement/database/moduleBootstrap"),
    eCommerce: () => import("../modules/eCommerce/database/moduleBootstrap"),
    eCommerceMarketplace: () => import("../modules/eCommerceMarketplace/database/moduleBootstrap"),
};

async function loadOptionalModuleBootstraps(): Promise<ModuleBootstrap[]> {
    const bootstraps: ModuleBootstrap[] = [];
    for (const moduleName of getEnabledModuleNames()) {
        const loader = OPTIONAL_MODULE_BOOTSTRAPS[moduleName];
        if (!loader || !isModuleEnabled(moduleName)) {
            continue;
        }
        bootstraps.push(await loader());
    }
    return bootstraps;
}

async function getAllModels(): Promise<Model<any>[]> {
    const optional = await loadOptionalModuleBootstraps();
    const optionalModels = optional.flatMap((b) => b.models ?? []);
    return [...coreModels, ...optionalModels];
}

export async function dropAll(parentLogger?: serverLogger){
    let logger = getLogger("mongoDbInitialization-dropAll", parentLogger);
    logger.start(`Dropping all schemas...`);

    for (const model of coreModels) {
        await model.collection.drop();
    }

    const optional = await loadOptionalModuleBootstraps();
    for (const bootstrap of optional) {
        if (bootstrap.dropModuleCollections) {
            await bootstrap.dropModuleCollections();
        } else if (bootstrap.models) {
            for (const model of bootstrap.models) {
                await model.collection.drop();
            }
        }
    }

    logger.finish(`Finished dropping all schemas!`);
}

export async function syncAllIndexes(parentLogger?: serverLogger) {
    let logger = getLogger("mongoDbInitialization-syncAllIndexes", parentLogger);
    logger.start(`Syncing all indexes...`);

    try {
        const models = await getAllModels();

        for (const model of models) {
            try {
                await model.syncIndexes();
                logger.debug(`Synced indexes for ${model.modelName}`);
            } catch (error: any) {
                logger.warn(`Failed to sync indexes for ${model.modelName}: ${error.message}`);
            }
        }

        logger.finish(`Finished syncing all indexes!`);
    } catch (error: any) {
        logger.err(`Error syncing indexes: ${error.message}`);
        logger.fail("Failed to sync indexes!");
    }
}

export async function initializeMongoDatabase(parentLogger?: serverLogger){
    let logger = getLogger("initializing_mongo_db_instance", parentLogger);
    logger.start(`Initializing mongoDb database...`);

    if( MONGO_DB.INIT || false ){
        logger.debug("The environment requires DB initialization");
        await dropAll(logger);
        await createRolePermissions(logger);
        await createUsers(logger);
        await createCompanies(logger, true);
        await syncAllIndexes(logger);
        logger.debug("The environment finished DB initialization!");
    }
    else{
        logger.debug("The environment forbids database initialization. The DB has NOT been touched!");
    }

    logger.finish(`Finished initializing mongoDb database!`);
    logger.updateSpace(-2);
}

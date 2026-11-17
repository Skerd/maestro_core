import {ObjectId} from "mongodb";
import User from "@coreModule/database/schemas/user/user";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";

export const defaultSysUsers: any[] = [
    {
        username: "echo@echo.com",
        surname: "silence",
        name: "echo",
        password: "echo",
        preferredLanguage: "en-US",
        isMainUser: true
    },
    {
        username: "user@test.com",
        surname: "Test",
        name: "User",
        password: "1234",
        // Not English, so a dev reset shows SMS/Telegram notices rendered in the receiver's language (D128).
        preferredLanguage: "de-CH",
        phoneNumber: "+470000000000"
    }
];

export async function createUsers(parentLogger?: serverLogger): Promise<void>{
    let logger = getLogger("mongoDbInitialization-createUsers", parentLogger);
    logger.start(`Creating users...`);
    try{
        let firstUserId: null | ObjectId = null;
        // The demo staff work in the platform company's zone (TD-B240: they read Europe/Berlin in Tirana). Loaded here:
        // the company defaults import the initializer, which loads this file.
        const {defaultCompaniesValues} = await import("@coreModule/database/schemas/company/company.defaults");
        const timezone = (defaultCompaniesValues.companies as {isPlatformOwner?: boolean; timezone?: string}[])
            .find((company) => company.isPlatformOwner)?.timezone;
        for( let newUser of defaultSysUsers ){

            let dbUser = await User.findOne({username: newUser.username});
            if( !dbUser ){
                let {name, surname, ...rest} = newUser;
                let createdUser = await new User({
                    fullName: `${name} ${surname}`,
                    name,
                    surname,
                    ...(timezone ? {timezone} : {}),
                    ...rest,
                    isEmailVerified: true
                }).save();

                if( !firstUserId ){
                    firstUserId = createdUser._id;
                }
                await User.findByIdAndUpdate(createdUser._id, {registeredFrom: firstUserId});
                logger.info(`Successfully created user named '${newUser.username}'`);
            }
            else{
                logger.info(`The user named '${newUser.username}' already exists.`)
            }
        }

        logger.finish(`Finished creating users!`);
    }
    catch(e: any){
        logger.err(`Error creating users: ${e.message}`);
        logger.fail("Failed to create users!");
    }
}

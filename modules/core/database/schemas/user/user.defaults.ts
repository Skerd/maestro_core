import {ObjectId} from "mongodb";
import User from "@coreModule/database/schemas/user/user";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";

export const defaultSysUsers: any[] = [
    {
        username: "echo@echo.com",
        surname: "silence",
        name: "echo",
        password: "echo",
        timezone: "Europe/Berlin",
        isMainUser: true
    },
    {
        username: "user@test.com",
        surname: "Test",
        name: "User",
        password: "1234",
        timezone: "Europe/Berlin",
        phoneNumber: "+470000000000"
    }
];

export async function createUsers(parentLogger?: serverLogger): Promise<void>{
    let logger = getLogger("mongoDbInitialization-createUsers", parentLogger);
    logger.start(`Creating users...`);
    try{
        let firstUserId: null | ObjectId = null;
        for( let newUser of defaultSysUsers ){

            let dbUser = await User.findOne({username: newUser.username});
            if( !dbUser ){
                let {name, surname, ...rest} = newUser;
                let createdUser = await new User({
                    fullName: `${name} ${surname}`,
                    name,
                    surname,
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

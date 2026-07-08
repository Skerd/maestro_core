import {ObjectId} from "mongodb";
import User from "@coreModule/database/schemas/user/user";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";

export const defaultSysUsers: any[] = [
    {
        username: "echo@echo.com",
        surname: "silence",
        name: "echo",
        password: "EchoPronix@10",
        timezone: "Europe/Berlin",
        isMainUser: true
    },
    {
        username: "almir@leka.com",
        surname: "Leka",
        name: "Almir",
        password: "1234",
        timezone: "Europe/Berlin",
        phoneNumber: "+470000000000"
    },
    {
        username: "skerd@xhafa.com",
        surname: "Xhafa",
        name: "Skerd",
        password: "1234",
        timezone: "Europe/Berlin",
        phoneNumber: "+355699991919"
    },
    {
        username: "gerald.habilaj@pronix.com",
        surname: "Habilaj",
        name: "Gerald",
        password: "1234",
        timezone: "Europe/Berlin",
        phoneNumber: "+355695667885"
    },
    {
        username: "eniada.halebi@pronix.com",
        surname: "Halebi",
        name: "Eniada",
        password: "1234",
        timezone: "Europe/Berlin",
        phoneNumber: "+41764370490"
    },
    {
        username: "geraldo.cucaj@pronix.com",
        surname: "Cucaj",
        name: "Geraldo",
        password: "1234",
        timezone: "Europe/Berlin",
        phoneNumber: "+355692866216"
    },

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

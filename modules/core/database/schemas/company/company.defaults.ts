import Company from "./company";
import {ObjectId} from "mongodb";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {defaultSysUsers} from "@coreModule/database/schemas/user/user.defaults";
import User from "@coreModule/database/schemas/user/user";

export const defaultCompaniesValues: any = {
    address: {
        countryCode: "AL",
        stateCode: "TR",
        cityName: "Tirana",
        street: "Myslym Shyr",
        postalCode: "1021",
        geoLocation: {
            latitude: 41.32426719964653,
            longitude: 19.80706909189647
        }
    },
    companies: [
        {
            "name": "Pronix",
            "email": "support@pronix.com",
            "description": "Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry's standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum.",
            "website": "https://pronix.al",
            "phoneNumber": "+355 696666666",
            "vat": "Z123456789Z",
            "isActive": true,
            "isDefaultForSignUp": true,
            "allowedDomains": ["*"]
        },
    ]
};

export async function createCompanies(parentLogger?: serverLogger, demoData: boolean = false){
    let logger = getLogger("mongoDbInitialization-createCompanies", parentLogger);
    logger.start(`Creating companies...`);
    let mainCompanyId: ObjectId | null = null;
    try{
        let mainUser = await User.findOne({username: defaultSysUsers.find((user) => user.isMainUser)?.username });

        for( let newCompany of defaultCompaniesValues.companies ){
            let currentCompany = await Company.findOne({name: newCompany.name, vat: newCompany.vat});
            if( !currentCompany ){

                let newCompanyId = new ObjectId();
                currentCompany = new Company({
                    _id: newCompanyId,
                    ...newCompany,
                    parentCompany: mainCompanyId,
                    createdBy: mainUser,
                    company: mainCompanyId ?? newCompanyId
                });
                await currentCompany.save();

                logger.debug("Creating needed company data...");
                await currentCompany.createDefaultRoles(logger);
                if( demoData ){
                    await currentCompany.addCompanyDemoData(logger);
                }
                logger.debug("Finished creating needed company data!");

                logger.debug(`Successfully created company named '${newCompany.name}' with VAT '${newCompany.vat}'`);
            }
            else{
                logger.debug(`The company named '${newCompany.name}' with VAT '${newCompany.vat}' already exists`);
                logger.debug("Creating needed company data...");
                await currentCompany.createDefaultRoles(logger);
                if( demoData ){
                    await currentCompany.addCompanyDemoData(logger);
                }
                logger.debug("Finished creating needed company data!");
            }

            if( !mainCompanyId ){
                mainCompanyId = currentCompany._id;
            }
        }
        logger.finish(`Finished creating companies!`);
    }
    catch(e: any){
        console.log(e);
        logger.err(`Error creating companies: ${e.message}`);
        logger.fail("Failed to create companies!");
    }
}

import Company from "./company";
import {ObjectId} from "mongodb";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {defaultSysUsers} from "@coreModule/database/schemas/user/user.defaults";
import User from "@coreModule/database/schemas/user/user";
import {ensureModuleDefaultRolesRegistered} from "@coreModule/utilities/modules/ensureModuleDefaultRoles";
import Country from "@coreModule/database/schemas/country/country";
import City from "@coreModule/database/schemas/city/city";

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
    // The first company is the parent of the rest and the platform owner: its admins
    // grant every company its modules. Each vertical demo company gets its own modules,
    // so its demo data lands only there. `"*"` keeps panel login on localhost working;
    // `<slug>.localhost` gives each public site an exact origin match.
    companies: [
        {
            "name": "Platform",
            "email": "platform@arpeggio.com",
            "description": "Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry's standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum.",
            "website": "https://platformarpeggio.al",
            "phoneNumber": "+355 696666666",
            "linkedin": "https://www.linkedin.com/company/platformarpeggio",
            "instagram": "https://www.instagram.com/platformarpeggio",
            "facebook": "https://www.facebook.com/platformarpeggio",
            "vat": "Z000000000Z",
            "isActive": true,
            "isPlatformOwner": true,
            "isDefaultForSignUp": true,
            "allowedDomains": ["*"],
            "modules": ["core"]
        },
        {
            "name": "eCommerce",
            "email": "ecommerce@arpeggio.com",
            "description": "Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry's standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum.",
            "website": "https://ecommercearpeggio.al",
            "phoneNumber": "+355 696666666",
            "linkedin": "https://www.linkedin.com/company/ecommercearpeggio",
            "instagram": "https://www.instagram.com/ecommercearpeggio",
            "facebook": "https://www.facebook.com/ecommercearpeggio",
            "vat": "Z123456789Z",
            "isActive": true,
            "shopSlug": "store",
            "shopListedOnPortal": true,
            "allowedDomains": ["*", "store.localhost"],
            "modules": ["core", "finance", "eCommerce"]
        },
        {
            "name": "Dental Clinic",
            "email": "clinic@arpeggio.com",
            "description": "Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry's standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum.",
            "website": "https://clinicarpeggio.al",
            "phoneNumber": "+355 696666666",
            "linkedin": "https://www.linkedin.com/company/clinicarpeggio",
            "instagram": "https://www.instagram.com/clinicarpeggio",
            "facebook": "https://www.facebook.com/clinicarpeggio",
            "vat": "Z223456789Z",
            "isActive": true,
            "shopSlug": "clinic",
            "allowedDomains": ["*", "clinic.localhost"],
            "modules": ["core", "finance", "dentalClinic"]
        },
        {
            "name": "Car Rental",
            "email": "rental@arpeggio.com",
            "description": "Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry's standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum.",
            "website": "https://rentalarpeggio.al",
            "phoneNumber": "+355 696666666",
            "linkedin": "https://www.linkedin.com/company/rentalarpeggio",
            "instagram": "https://www.instagram.com/rentalarpeggio",
            "facebook": "https://www.facebook.com/rentalarpeggio",
            "vat": "Z323456789Z",
            "isActive": true,
            "shopSlug": "rental",
            "allowedDomains": ["*", "rental.localhost"],
            "modules": ["core", "finance", "carRental"]
        },
        {
            "name": "Estates",
            "email": "estates@arpeggio.com",
            "description": "Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry's standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum.",
            "website": "https://estatesarpeggio.al",
            "phoneNumber": "+355 696666666",
            "linkedin": "https://www.linkedin.com/company/estatesarpeggio",
            "instagram": "https://www.instagram.com/estatesarpeggio",
            "facebook": "https://www.facebook.com/estatesarpeggio",
            "vat": "Z423456789Z",
            "isActive": true,
            "shopSlug": "estates",
            "allowedDomains": ["*", "estates.localhost"],
            "modules": ["core", "propertyManagement", "propertyDevelopment"]
        },
    ]
};

/**
 * Gives a demo company the default address, from its own country and city records (seeded
 * per company by `addCompanyDemoData`). Its city is what the portal's "where" search matches.
 */
async function addDefaultAddress(company: any): Promise<void> {
    if (company.addresses?.length) return;
    const {address} = defaultCompaniesValues;
    const [country, city] = await Promise.all([
        Country.findOne({company: company._id, code: address.countryCode}).select("_id"),
        City.findOne({company: company._id, name: address.cityName}).select("_id"),
    ]);
    if (!country || !city) return;
    company.addresses = [{
        street: address.street,
        postalCode: address.postalCode,
        country: country._id,
        city: city._id,
        latitude: address.geoLocation.latitude,
        longitude: address.geoLocation.longitude,
    }];
    await company.save();
}

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
                    await addDefaultAddress(currentCompany);
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
                    await addDefaultAddress(currentCompany);
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

export async function syncAllCompanyDefaultRoles(parentLogger?: serverLogger): Promise<void> {
    const logger = getLogger("sync_company_default_roles", parentLogger);
    logger.start("Syncing default roles for all companies...");
    await ensureModuleDefaultRolesRegistered(logger);
    const companies = await Company.find({});
    for (const company of companies) {
        await company.createDefaultRoles(logger);
    }
    logger.finish(`Finished syncing default roles for ${companies.length} company(ies)!`);
}

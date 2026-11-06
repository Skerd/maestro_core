import Company from "./company";
import {ObjectId} from "mongodb";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {defaultSysUsers} from "@coreModule/database/schemas/user/user.defaults";
import User from "@coreModule/database/schemas/user/user";
import {ensureModuleDefaultRolesRegistered} from "@coreModule/utilities/modules/ensureModuleDefaultRoles";
import Country from "@coreModule/database/schemas/country/country";
import City from "@coreModule/database/schemas/city/city";
import {resolveDemoImagesFromUnsplash} from "@coreModule/database/demo/demoMedia";
import {seedCoreDemoData} from "@coreModule/database/demo/coreCompanyDemo";

/** Square mark cropped from a photo that matches the business. Unsplash id, fetched once. */
const COMPANY_LOGO_SIZE = {width: 512, height: 512};

type DemoAddress = {
    countryCode: string;
    cityName: string;
    street: string;
    postalCode: string;
    geoLocation: {latitude: number; longitude: number};
};

export const defaultCompaniesValues: any = {
    // Shared Tirana address for ecommerce demo orders, warehouses, and checkouts.
    // Company profiles use their own `demoAddress` below.
    address: {
        countryCode: "AL",
        stateCode: "TR",
        cityName: "Tirana",
        street: "Rruga Myslym Shyri 26",
        postalCode: "1001",
        geoLocation: {
            latitude: 41.3234,
            longitude: 19.8182,
        },
    },
    // The first company is the parent of the rest and the platform owner: its admins
    // grant every company its modules. Each vertical demo company gets its own modules,
    // so its demo data lands only there. `"*"` keeps panel login on localhost working;
    // `<slug>.localhost` gives each public site an exact origin match.
    // VAT is the stable key: a re-seed updates the profile of the company that already
    // holds that VAT instead of inserting a second one.
    companies: [
        {
            "name": "Arpeggio",
            "email": "platform@arpeggio.com",
            "description": "Arpeggio runs the companies on this portal. It handles tenancy, sign-in, and the public sites for the shop, the clinic, the rental desk, and the estate developer.",
            "website": "https://arpeggio.io",
            "phoneNumber": "+355 4 223 0100",
            "linkedin": "https://www.linkedin.com/company/arpeggio",
            "instagram": "https://www.instagram.com/arpeggio",
            "facebook": "https://www.facebook.com/arpeggio",
            "vat": "Z000000000Z",
            "isActive": true,
            "isPlatformOwner": true,
            "isDefaultForSignUp": true,
            "allowedDomains": ["*"],
            "modules": ["core"],
            "logoPhotoId": "1486406146926-c627a92ad1ab",
            "demoAddress": {
                countryCode: "AL",
                cityName: "Tirana",
                street: "Rruga Ibrahim Rugova 1",
                postalCode: "1001",
                geoLocation: {latitude: 41.3210, longitude: 19.8225},
            },
        },
        {
            "name": "Arpeggio Market",
            "email": "ecommerce@arpeggio.com",
            "description": "Arpeggio Market is a Tirana shop and services marketplace. It sells ready-to-ship goods and commissioned work from independent providers, with checkout, delivery, and client messages in one place.",
            "website": "https://market.arpeggio.io",
            "phoneNumber": "+355 4 223 0140",
            "linkedin": "https://www.linkedin.com/company/arpeggiomarket",
            "instagram": "https://www.instagram.com/arpeggiomarket",
            "facebook": "https://www.facebook.com/arpeggiomarket",
            "vat": "Z123456789Z",
            "isActive": true,
            "isPlatformOwner": false,
            "isDefaultForSignUp": false,
            "siteSlug": "store",
            "shopListedOnPortal": true,
            "allowedDomains": ["*", "store.localhost"],
            "modules": ["core", "finance", "eCommerce"],
            "logoPhotoId": "1441986300917-64674bd600d8",
            "demoAddress": {
                countryCode: "AL",
                cityName: "Tirana",
                street: "Rruga Myslym Shyri 26",
                postalCode: "1001",
                geoLocation: {latitude: 41.3234, longitude: 19.8182},
            },
        },
        {
            "name": "Blloku Dental",
            "email": "clinic@arpeggio.com",
            "description": "Blloku Dental is a family practice in Tirana, with studios in Blloku and Kombinat. Patients book check-ups, cleanings, fillings, whitening, and orthodontic consultations online.",
            "website": "https://clinic.arpeggio.io",
            "phoneNumber": "+355 69 203 1100",
            "linkedin": "https://www.linkedin.com/company/bllokudental",
            "instagram": "https://www.instagram.com/bllokudental",
            "facebook": "https://www.facebook.com/bllokudental",
            "vat": "Z223456789Z",
            "isActive": true,
            "isPlatformOwner": false,
            "isDefaultForSignUp": false,
            "siteSlug": "clinic",
            "allowedDomains": ["*", "clinic.localhost"],
            "modules": ["core", "finance", "dentalClinic"],
            "logoPhotoId": "1629909613654-28e377c37b09",
            "demoAddress": {
                countryCode: "AL",
                cityName: "Tirana",
                street: "Rruga Pjetër Bogdani 7",
                postalCode: "1019",
                geoLocation: {latitude: 41.3194, longitude: 19.8167},
            },
        },
        {
            "name": "Adriatic Drive",
            "email": "rental@arpeggio.com",
            "description": "Adriatic Drive rents late-model cars from Tirana for city days and trips down the coast. Every vehicle is insured, serviced, and available for pickup at the desk or at the airport.",
            "website": "https://drive.arpeggio.io",
            "phoneNumber": "+355 69 204 2200",
            "linkedin": "https://www.linkedin.com/company/adriaticdrive",
            "instagram": "https://www.instagram.com/adriaticdrive",
            "facebook": "https://www.facebook.com/adriaticdrive",
            "vat": "Z323456789Z",
            "isActive": true,
            "isPlatformOwner": false,
            "isDefaultForSignUp": false,
            "siteSlug": "rental",
            "allowedDomains": ["*", "rental.localhost"],
            "modules": ["core", "finance", "carRental"],
            "logoPhotoId": "1503376780353-7e6692767b70",
            "demoAddress": {
                countryCode: "AL",
                cityName: "Tirana",
                street: "Rruga e Kavajës 88",
                postalCode: "1001",
                geoLocation: {latitude: 41.3272, longitude: 19.8078},
            },
        },
        {
            "name": "Aria Estates",
            "email": "estates@arpeggio.com",
            "description": "Aria Estates develops and sells homes in Tirana and on the Albanian Riviera, including Garda Tower and Aria Residence in Dhërmi. Buyers reserve, finance, and follow construction from one account.",
            "website": "https://estates.arpeggio.io",
            "phoneNumber": "+355 69 205 3300",
            "linkedin": "https://www.linkedin.com/company/ariaestates",
            "instagram": "https://www.instagram.com/ariaestates",
            "facebook": "https://www.facebook.com/ariaestates",
            "vat": "Z423456789Z",
            "isActive": true,
            "isPlatformOwner": false,
            "isDefaultForSignUp": false,
            "siteSlug": "estates",
            "allowedDomains": ["*", "estates.localhost"],
            "modules": ["core", "propertyManagement", "propertyDevelopment"],
            "logoPhotoId": "1560448204-e02f11c3d0e2",
            "demoAddress": {
                countryCode: "AL",
                cityName: "Tirana",
                street: "Rruga Abdi Toptani 6",
                postalCode: "1001",
                geoLocation: {latitude: 41.3275, longitude: 19.8189},
            },
        },
        {
            "name": "Alpine Reach",
            "email": "outreach@arpeggio.com",
            "description": "Alpine Reach finds Swiss companies that fit a client's offer, researches each one and drafts a personal first e-mail that the client approves before it is sent.",
            "website": "https://reach.arpeggio.io",
            "phoneNumber": "+41 44 500 21 30",
            "linkedin": "https://www.linkedin.com/company/alpinereach",
            "vat": "CHE-523.456.789",
            "isActive": true,
            "isPlatformOwner": false,
            "isDefaultForSignUp": false,
            "siteSlug": "reach",
            "allowedDomains": ["reach.localhost"],
            "modules": ["core", "swissOutreach"],
            "demoAddress": {
                countryCode: "CH",
                cityName: "Zürich",
                street: "Bahnhofstrasse 42",
                postalCode: "8001",
                geoLocation: {latitude: 47.3712, longitude: 8.5393},
            },
        },
    ]
};

const PROFILE_KEYS = [
    "name", "email", "description", "website", "phoneNumber",
    "linkedin", "instagram", "facebook", "isActive", "allowedDomains",
    "siteSlug", "shopListedOnPortal", "isDefaultForSignUp", "isPlatformOwner",
] as const;

function actorId(createdBy: any): ObjectId | undefined {
    if (!createdBy) return undefined;
    if (createdBy instanceof ObjectId) return createdBy;
    const raw = createdBy._id ?? createdBy;
    if (!raw) return undefined;
    return raw instanceof ObjectId ? raw : new ObjectId(String(raw));
}

/**
 * Copies the authored profile onto a company. `modules` is applied only when the
 * company is first created: an existing company may already be using a wider set
 * (the live shop was seeded before modules were stored on the document).
 */
function applyCompanyProfile(company: any, seed: any, includeModules: boolean): void {
    for (const key of PROFILE_KEYS) {
        if (seed[key] !== undefined) {
            company[key] = seed[key];
        }
    }
    if (includeModules && seed.modules) {
        company.modules = seed.modules;
    }
}

/**
 * Sets the company's street address from its own country and city records (seeded
 * per company by `addCompanyDemoData`). The city is what the portal's "where" search matches.
 */
async function applyDemoAddress(company: any, address: DemoAddress | undefined): Promise<void> {
    if (!address) return;
    const [country, city] = await Promise.all([
        Country.findOne({company: company._id, code: address.countryCode}).select("_id"),
        City.findOne({company: company._id, name: address.cityName}).select("_id"),
    ]);
    if (!country || !city) return;
    const current = company.addresses?.[0];
    company.addresses = [{
        ...(current?._id ? {_id: current._id} : {}),
        street: address.street,
        postalCode: address.postalCode,
        country: country._id,
        city: city._id,
        latitude: address.geoLocation.latitude,
        longitude: address.geoLocation.longitude,
    }];
    await company.save();
}

/** Uploads the company's mark once and points `logo` at that Media row. */
async function ensureCompanyLogo(company: any, photoId: string | undefined, parentLogger?: serverLogger): Promise<void> {
    if (!photoId) return;
    const createdBy = actorId(company.createdBy);
    if (!createdBy) return;
    const images = await resolveDemoImagesFromUnsplash(
        [photoId],
        `company-${company.vat}`,
        company.name,
        company,
        createdBy,
        parentLogger ?? getLogger("company_logo"),
        "company-logo",
        COMPANY_LOGO_SIZE,
    );
    if (!images.mainImageId) return;
    if (String(company.logo ?? "") === images.mainImageId.toHexString()) return;
    company.logo = images.mainImageId;
    await company.save();
}

/** Keeps the company bot's display name in step with the company name. */
async function syncCompanyBot(company: any): Promise<void> {
    const compact = String(company.name).replace(/ /g, "");
    const username = `${compact} AI Bot`;
    const bot = await User.findOne({companies: company._id, isBot: true});
    if (!bot || bot.username === username) return;
    bot.username = username;
    bot.name = `${compact} AI`;
    bot.surname = "Bot";
    bot.fullName = username;
    await bot.save();
}

export async function createCompanies(parentLogger?: serverLogger, demoData: boolean = false){
    let logger = getLogger("mongoDbInitialization-createCompanies", parentLogger);
    logger.start(`Creating companies...`);
    let mainCompanyId: ObjectId | null = null;
    try{
        let mainUser = await User.findOne({username: defaultSysUsers.find((user) => user.isMainUser)?.username });

        for( let newCompany of defaultCompaniesValues.companies ){
            const {demoAddress, logoPhotoId, ...profile} = newCompany;
            let currentCompany = await Company.findOne({vat: profile.vat});
            const existed = !!currentCompany;
            if( !currentCompany ){

                let newCompanyId = new ObjectId();
                currentCompany = new Company({
                    _id: newCompanyId,
                    ...profile,
                    parentCompany: mainCompanyId,
                    createdBy: mainUser,
                    company: mainCompanyId ?? newCompanyId
                });
                await currentCompany.save();

                logger.debug(`Successfully created company named '${profile.name}' with VAT '${profile.vat}'`);
            }
            else{
                logger.debug(`The company with VAT '${profile.vat}' already exists; updating its profile`);
                applyCompanyProfile(currentCompany, profile, false);
                if (mainCompanyId && String(currentCompany._id) !== String(mainCompanyId)) {
                    currentCompany.set("parentCompany", mainCompanyId);
                }
                await currentCompany.save();
            }

            logger.debug("Creating needed company data...");
            await currentCompany.createDefaultRoles(logger);
            if( demoData ){
                if (!existed) {
                    await currentCompany.addCompanyDemoData(logger);
                } else {
                    // Profile, address, and logo are refreshed below. The full module
                    // seed is not replayed: it would rebuild catalogs that already exist.
                    await seedCoreDemoData(logger, currentCompany);
                }
                await applyDemoAddress(currentCompany, demoAddress);
                await ensureCompanyLogo(currentCompany, logoPhotoId, logger);
                await syncCompanyBot(currentCompany);
            }
            logger.debug("Finished creating needed company data!");

            if( !mainCompanyId ){
                mainCompanyId = currentCompany._id;
            }
        }
        logger.finish(`Finished creating companies!`);
    }
    catch(e: any){
        logger.err(`Error creating companies: ${e.message}`);
        if (e instanceof Error && e.stack) logger.debug(e.stack);
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

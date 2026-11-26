import Company, {type ICompany} from "./company";
import {ObjectId} from "mongodb";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {defaultSysUsers} from "@coreModule/database/schemas/user/user.defaults";
import User from "@coreModule/database/schemas/user/user";
import {ensureModuleDefaultRolesRegistered} from "@coreModule/utilities/modules/ensureModuleDefaultRoles";
import Country from "@coreModule/database/schemas/country/country";
import City from "@coreModule/database/schemas/city/city";
import {createCurrencies} from "@coreModule/database/schemas/currency/currency.defaults";
import {createCountries} from "@coreModule/database/schemas/country/country.defaults";
import {createStates} from "@coreModule/database/schemas/state/state.defaults";
import {createCities} from "@coreModule/database/schemas/city/city.defaults";
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
            "name": "Kudoo",
            "email": "platform@kudoo.al",
            "description": "Kudoo runs the companies on this portal. It handles tenancy, sign-in, and the public sites for the shop, the clinic, the rental desk, and the estate developer.",
            "website": "https://kudoo.al",
            "phoneNumber": "+355 4 223 0100",
            "linkedin": "https://www.linkedin.com/company/kudoo",
            "instagram": "https://www.instagram.com/kudoo",
            "facebook": "https://www.facebook.com/kudoo",
            "vat": "Z000000000Z",
            "timezone": "Europe/Tirane",
            "isActive": true,
            "isPlatformOwner": true,
            "isProtected": true,
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
            "name": "Kudoo Market",
            "email": "ecommerce@kudoo.al",
            "description": "Kudoo Market is a Tirana fashion shop. It sells clothes, shoes and accessories for women, men and kids, with checkout, delivery, and client messages in one place.",
            "website": "https://market.kudoo.al",
            "phoneNumber": "+355 4 223 0140",
            "linkedin": "https://www.linkedin.com/company/kudoomarket",
            "instagram": "https://www.instagram.com/kudoomarket",
            "facebook": "https://www.facebook.com/kudoomarket",
            "vat": "Z123456789Z",
            "timezone": "Europe/Tirane",
            "isActive": true,
            "isPlatformOwner": false,
            "isDefaultForSignUp": false,
            "siteSlug": "store",
            "bankAccount": {"holder": "Kudoo Market sh.p.k.", "iban": "AL47212110090000000235698741", "bic": "BKTRALTR", "bankName": "BKT"},
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
            // The services marketplace's operator (D143): it owns the shared service categories and every job posted
            // on the portal, so it is protected and sells nothing itself. The marketplace module finds it by its VAT.
            "name": "Kudoo Services",
            "email": "services@kudoo.al",
            "description": "Kudoo Services runs the services marketplace on the portal. It keeps one list of service categories, takes the jobs clients post and passes each one to the providers who do that work.",
            "website": "https://services.kudoo.al",
            "phoneNumber": "+355 4 223 0110",
            "vat": "Z000000001Z",
            "timezone": "Europe/Tirane",
            "isActive": true,
            "isPlatformOwner": false,
            "isProtected": true,
            "isDefaultForSignUp": false,
            // Its own site is the public task board (D172).
            "siteSlug": "tasks",
            "modules": ["core", "finance", "marketplace"],
            "demoAddress": {
                countryCode: "AL",
                cityName: "Tirana",
                street: "Rruga Ibrahim Rugova 1",
                postalCode: "1001",
                geoLocation: {latitude: 41.3210, longitude: 19.8225},
            },
        },
        {
            "name": "Tirana Pros",
            "email": "pros@kudoo.al",
            "description": "Tirana Pros is a services marketplace in Tirana. Clients hire independent designers, developers, writers and translators at a fixed price, or post a job and compare their bids, and pay the provider directly.",
            "website": "https://pros.kudoo.al",
            "phoneNumber": "+355 4 223 0170",
            "linkedin": "https://www.linkedin.com/company/tiranapros",
            "instagram": "https://www.instagram.com/tiranapros",
            "facebook": "https://www.facebook.com/tiranapros",
            "vat": "Z523456789Z",
            "timezone": "Europe/Tirane",
            "isActive": true,
            "isPlatformOwner": false,
            "isDefaultForSignUp": false,
            "siteSlug": "pros",
            "bankAccount": {"holder": "Tirana Pros sh.p.k.", "iban": "AL41213110290000000033001120", "bic": "NCBAALTX", "bankName": "Banka OTP Albania"},
            "allowedDomains": ["pros.localhost"],
            "modules": ["core", "finance", "marketplace"],
            "logoPhotoId": "1561070791-2526d30994b5",
            "demoAddress": {
                countryCode: "AL",
                cityName: "Tirana",
                street: "Rruga e Kavajës 27",
                postalCode: "1001",
                geoLocation: {latitude: 41.3262, longitude: 19.8106},
            },
        },
        {
            "name": "Adria Home Fix",
            "email": "fix@kudoo.al",
            "description": "Adria Home Fix sends plumbers, electricians, cleaners and handymen to homes in Durrës and Tirana. Clients book a service or post a job and get a quote.",
            "website": "https://fix.kudoo.al",
            "phoneNumber": "+355 52 223 0180",
            "linkedin": "https://www.linkedin.com/company/adriahomefix",
            "instagram": "https://www.instagram.com/adriahomefix",
            "facebook": "https://www.facebook.com/adriahomefix",
            "vat": "Z623456789Z",
            "timezone": "Europe/Tirane",
            "isActive": true,
            "isPlatformOwner": false,
            "isDefaultForSignUp": false,
            "siteSlug": "fix",
            "bankAccount": {"holder": "Adria Home Fix sh.p.k.", "iban": "AL94205110400000000040022110", "bic": "RZBAALTR", "bankName": "Raiffeisen Bank"},
            "allowedDomains": ["fix.localhost"],
            "modules": ["core", "finance", "marketplace"],
            "logoPhotoId": "1504148455328-c376907d081c",
            "demoAddress": {
                countryCode: "AL",
                cityName: "Durrës",
                street: "Rruga Tregtare 12",
                postalCode: "2001",
                geoLocation: {latitude: 41.3231, longitude: 19.4414},
            },
        },
        {
            "name": "Blloku Dental",
            "email": "clinic@kudoo.al",
            "description": "Blloku Dental is a family practice in Tirana, with studios in Blloku and Kombinat. Patients book check-ups, cleanings, fillings, whitening, and orthodontic consultations online.",
            "website": "https://clinic.kudoo.al",
            "phoneNumber": "+355 69 203 1100",
            "linkedin": "https://www.linkedin.com/company/bllokudental",
            "instagram": "https://www.instagram.com/bllokudental",
            "facebook": "https://www.facebook.com/bllokudental",
            "vat": "Z223456789Z",
            "timezone": "Europe/Tirane",
            "isActive": true,
            "isPlatformOwner": false,
            "isDefaultForSignUp": false,
            "siteSlug": "clinic",
            "bankAccount": {"holder": "Blloku Dental sh.p.k.", "iban": "AL35202111090000000001234567", "bic": "SGSBALTX", "bankName": "Credins Bank"},
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
            "email": "rental@kudoo.al",
            "description": "Adriatic Drive rents late-model cars from Tirana for city days and trips down the coast. Every vehicle is insured, serviced, and available for pickup at the desk or at the airport.",
            "website": "https://drive.kudoo.al",
            "phoneNumber": "+355 69 204 2200",
            "linkedin": "https://www.linkedin.com/company/adriaticdrive",
            "instagram": "https://www.instagram.com/adriaticdrive",
            "facebook": "https://www.facebook.com/adriaticdrive",
            "vat": "Z323456789Z",
            "timezone": "Europe/Tirane",
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
            "email": "estates@kudoo.al",
            "description": "Aria Estates develops and sells homes in Tirana and on the Albanian Riviera, including Garda Tower and Aria Residence in Dhërmi. Buyers reserve, finance, and follow construction from one account.",
            "website": "https://estates.kudoo.al",
            "phoneNumber": "+355 69 205 3300",
            "linkedin": "https://www.linkedin.com/company/ariaestates",
            "instagram": "https://www.instagram.com/ariaestates",
            "facebook": "https://www.facebook.com/ariaestates",
            "vat": "Z423456789Z",
            "timezone": "Europe/Tirane",
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
            "email": "outreach@kudoo.al",
            "description": "Alpine Reach finds Swiss companies that fit a client's offer, researches each one and drafts a personal first e-mail that the client approves before it is sent.",
            "website": "https://reach.kudoo.al",
            "phoneNumber": "+41 44 500 21 30",
            "linkedin": "https://www.linkedin.com/company/alpinereach",
            "vat": "CHE-523.456.789",
            "timezone": "Europe/Zurich",
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
    "siteSlug", "timezone", "shopListedOnPortal", "isDefaultForSignUp", "isPlatformOwner", "isProtected", "bankAccount",
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
 * Sets the company's street address from the platform's country and city lists (D160). The city is what the portal's
 * "where" search matches.
 */
/** Points the company's address at the seeded country and city, and the city's state (TD-B241: it had none). */
export async function applyDemoAddress(company: any, address: DemoAddress | undefined): Promise<void> {
    if (!address) return;
    const country = await Country.findOne({code: address.countryCode}).select("_id");
    const city = country ? await City.findOne({country: country._id, name: address.cityName}).select("_id state") : null;
    if (!country || !city) return;
    const current = company.addresses?.[0];
    company.addresses = [{
        ...(current?._id ? {_id: current._id} : {}),
        street: address.street,
        postalCode: address.postalCode,
        country: country._id,
        ...(city.state ? {state: city.state} : {}),
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

/** Currencies, countries, states and cities: the platform lists, owned by the platform company (D160). */
async function createPlatformLists(logger: serverLogger, platformCompany: ICompany): Promise<void> {
    await createCurrencies(logger, platformCompany);
    await createCountries(logger, platformCompany);
    await createStates(logger, platformCompany);
    await createCities(logger, platformCompany);
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
            if (currentCompany.isPlatformOwner) {
                // The platform lists (D160) are seeded once, owned by the platform company; every company reads them.
                await createPlatformLists(logger, currentCompany);
            }
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

import mongoose, {Document, Schema, SchemaTypes} from 'mongoose';
import {ClientSession, Decimal128, ObjectId} from "mongodb";
import Role, {IRole} from "@coreModule/database/schemas/role/role";
import Finance, {FinanceCurrencies} from "@coreModule/database/schemas/finance/finance";
import Currency from "@coreModule/database/schemas/currency/currency";
import User, {IEmbeddedCompanyRole} from "@coreModule/database/schemas/user/user";
import {generateRandomString} from "@coreModule/utilities/helpers";
import RolePermission from "@coreModule/database/schemas/rolePermission/rolePermission";
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {ICity} from "@coreModule/database/schemas/city/city";
import {IState} from "@coreModule/database/schemas/state/state";
import {ICountry} from "@coreModule/database/schemas/country/country";
import {applyCompanyIndexes} from "./company.indexes";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import {IOwnershipPluginFields, ISoftDeletePluginFields} from "@coreModule/database/types/plugin-fields";
import {createCurrencies} from "@coreModule/database/schemas/currency/currency.defaults";
import {createCountries} from "@coreModule/database/schemas/country/country.defaults";
import {createStates} from "@coreModule/database/schemas/state/state.defaults";
import {createCities} from "@coreModule/database/schemas/city/city.defaults";
import {addModelData} from "@coreModule/database/collections";
import {COLUMN_TYPE} from "armonia/src/modules/core/database/filter/typeOperators";
import {CitySimpleSnippet} from "@coreModule/database/schemas/city/city.snippets";
import {StateSimpleSnippet} from "@coreModule/database/schemas/state/state.snippets";
import {CountrySimpleSnippet} from "@coreModule/database/schemas/country/country.snippets";
import {CompanyBlankSnippet} from "./company.snippets";
import {companyViews} from "./company.views";
import {defaultRoles} from "@coreModule/database/schemas/role/role.defaults";
import {defaultSysUsers} from "@coreModule/database/schemas/user/user.defaults";
import {runModuleCompanyDemoSeeds} from "@coreModule/utilities/modules/runModuleCompanyDemoSeeds";
import {validateSchemaDefAgainstMongoose} from "@coreModule/database/utilities/validateSchemaDefAgainstMongoose";
import {CompanySchemaDef} from "armonia/src/modules/core/api/company/private/company/company.schema-def";
import {ensureAiChannel} from "@coreModule/database/schemas/channel/aiChannel.helper";

function documentObjectId(ref: unknown): ObjectId | null {
    if (ref == null) return null;
    if (ref instanceof ObjectId) return ref;
    if (typeof ref === "object" && "_id" in ref && (ref as {_id: unknown})._id instanceof ObjectId) {
        return (ref as {_id: ObjectId})._id;
    }
    return null;
}

export interface ICompany extends Document, IOwnershipPluginFields, ISoftDeletePluginFields {
    name: string;
    email: string;
    phoneNumber: string;
    addresses?: {
        _id?: mongoose.Types.ObjectId;
        street?: string;
        postalCode?: string;
        city?: ICity;
        state?: IState;
        country?: ICountry;
        latitude?: number;
        longitude?: number;
    }[];
    description: string;
    logo: ObjectId;
    website: string;
    vat: string;
    parentCompany?: ICompany;
    isActive: boolean;
    isDefaultForSignUp: boolean;
    allowedDomains: string[];
    propertyManagementSettings?: {
        requiresSaleApproval?: boolean;
    };
    createBot: () => Promise<void>;
    ensureAiChannels: (session?: ClientSession | null) => Promise<void>;
    getRobotId: () => Promise<ObjectId>,
    createDefaultRoles: (parentLogger?: serverLogger, session?: ClientSession) => Promise<void>;
    assignCreatorFinanceAndRoles: (session?: ClientSession | null) => Promise<void>;
    addCompanyDemoData: (parentLogger?: serverLogger, session?: ClientSession) => Promise<void>;
    getAllRoles: (fetchAdminRoles?: boolean) => Promise<IRole[]>;
}

const CompanySchema: Schema = new Schema(
    {
        name: {
            type: SchemaTypes.String,
            required: true
        },
        email: {
            type: SchemaTypes.String,
            lowercase: true
        },
        phoneNumber: {
            type: SchemaTypes.String,
        },
        addresses: {
            validate: {
                validator: (v: any[]) => v.length <= 10,
                message: "A company cannot have more than 10 addresses",
            },
            type: [{
                street: {
                    type: SchemaTypes.String,
                    required: true,
                    dynamicTableConfiguration: {
                        hideColumn: true
                    }
                },
                postalCode: {
                    type: SchemaTypes.String,
                    required: true,
                    dynamicTableConfiguration: {
                        hideColumn: true
                    }
                },
                city: {
                    type: SchemaTypes.ObjectId,
                    ref: "City",
                    required: true,
                    refAllowlist: CitySimpleSnippet,
                    dynamicTableConfiguration: {
                        refDisplayKey: ["name"],
                        hideColumn: true
                    }
                },
                state: {
                    type: SchemaTypes.ObjectId,
                    ref: "State",
                    refAllowlist: StateSimpleSnippet,
                    dynamicTableConfiguration: {
                        refDisplayKey: ["name"],
                        hideColumn: true
                    }
                },
                country: {
                    type: SchemaTypes.ObjectId,
                    ref: "Country",
                    required: true,
                    refAllowlist: CountrySimpleSnippet,
                    dynamicTableConfiguration: {
                        refDisplayKey: ["name"],
                        hideColumn: true
                    }
                },
                latitude: {
                    type: SchemaTypes.Number,
                    dynamicTableConfiguration: {
                        hideColumn: true
                    }
                },
                longitude: {
                    type: SchemaTypes.Number,
                    dynamicTableConfiguration: {
                        hideColumn: true
                    }
                }
            }],
            default: [],
            dynamicTableConfiguration: {
                filterable: false,
                sortable: false,
                cellType: COLUMN_TYPE.ADDRESS
            }
        },
        description: {
            type: SchemaTypes.String,
            default: ''
        },
        logo: {
            type: SchemaTypes.ObjectId,
            ref: "Media",
            dynamicTableConfiguration: {
                filterable: false,
                sortable: false,
                cellType: COLUMN_TYPE.AVATAR
            }
        },
        website: {
            type: SchemaTypes.String
        },
        vat: {
            type: SchemaTypes.String,
            required: true,
            unique: true
        },
        parentCompany: {
            type: Schema.Types.ObjectId,
            ref: "Company",
            default: null,
            refAllowlist: CompanyBlankSnippet
        },
        isActive: {
            type: SchemaTypes.Boolean,
            default: true
        },
        isDefaultForSignUp: {
            type: SchemaTypes.Boolean,
            default: false,
            required: true,
            permissions: {
                self: {
                    read: "no-permission",
                    write: "no-permission"
                },
                others: {
                    read: "no-permission",
                    write: "no-permission"
                }
            }
        },
        allowedDomains: {
            type: [SchemaTypes.String],
            default: [],
            required: true
        },
        propertyManagementSettings: {
            type: {
                requiresSaleApproval: {type: SchemaTypes.Boolean, required: false, default: false},
            },
            required: false,
            default: undefined,
            permissions: {
                self: {write: "no-permission"},
                others: {write: "no-permission"},
            },
        },
    },
    {
        accessMode: "loose",
    }
);

CompanySchema.pre("save", function (next) {
    this.$locals = this.$locals || {};
    this.$locals.companyWasNew = this.isNew;
    next();
});

CompanySchema.post("save", async function (doc) {
    if (doc.$locals.companyWasNew) {
        const session = doc.$session();
        await doc.createDefaultRoles(undefined, session ?? undefined);
        await doc.assignCreatorFinanceAndRoles(session);
        await doc.createBot();
        await doc.ensureAiChannels(session ?? undefined);
    }
});

CompanySchema.methods.createDefaultRoles = async function (parentLogger?: serverLogger, session?: ClientSession){

    let logger =  getLogger("creating/updating_company_default_roles", parentLogger);
    logger.start(`Creating/updating company roles for company named '${this.name}' with VAT '${this.vat}'...`);

    try{
        if( defaultRoles.length === 0 ){
            logger.debug(`No default roles found`);
        }
        else {
            // let mainUser = await User.findOne({username: defaultSysUsers.find((user) => user.isMainUser)?.username });

            let savedRoles = await Role.find({company: this._id, slug: {$in: defaultRoles.map(role => this.name.toLowerCase() + ( role.isAdmin ? ":reserved:" : ":default:" ) + role.slug )} }).session(session);
            let savedRolesSlugs = savedRoles.map((role) => role.slug);

            let rolesToCreate = defaultRoles.filter((role) => !savedRolesSlugs.includes(this.name.toLowerCase() + ( role.isAdmin ? ":reserved:" : ":default:" ) + role.slug));
            let createdRoles: IRole[] = [];

            for( let adminRole of savedRoles ){
                let allMissingPermissions = await RolePermission.find(
                    {
                        _id: {
                            $nin: adminRole.permissions.map((permission) => {
                                return permission._id;
                            })
                        }
                    }
                ).select("_id").session(session);
                adminRole.permissions = [
                    ...adminRole.permissions,
                    ...(allMissingPermissions || [])
                ]
                await adminRole.save({session});
                logger.debug(`The company admin role named '${adminRole.name}' with slug '${adminRole.slug}' already exists. Updated [permissions]`);
            }
            for( let role of rolesToCreate ){
                let permissions = await RolePermission.find().select("_id").session(session);
                let newRole = await new Role({
                    _id: new ObjectId(),
                    company: this._id,
                    createdBy: this.createdBy,
                    name: role.name,
                    slug: this.name.toLowerCase() + ( role.isAdmin ? ":reserved:" : ":default:" ) + role.slug,
                    isAdmin: role.isAdmin,
                    isSignupDefault: role.isSignupDefault,
                    canEdit: role.canEdit,
                    canDelete: role.canDelete,
                    permissions: role.isAdmin ? permissions : []
                }).save({session});
                createdRoles.push(newRole);
                logger.debug(`Created role named '${role.name}' with slug '${role.slug}'`);
            }

            /** Default system users get every default role; creator is wired in assignCreatorFinanceAndRoles (admin + finance). */
            const allCompanyRoles = [...savedRoles, ...createdRoles];
            const allRoleIds = allCompanyRoles.map((role) => role._id);

            let defaultUserIds = await User.find({username: {$in: defaultSysUsers.map((user) => user.username)}}).select("_id").session(session);
            const creatorId = documentObjectId(this.createdBy);
            const defaultIdList = defaultUserIds?.map((user) => user._id) || [];
            const idsForFullRoles = creatorId
                ? defaultIdList.filter((id) => !id.equals(creatorId))
                : defaultIdList;

            if (idsForFullRoles.length > 0 && allRoleIds.length > 0) {
                await User.updateMany(
                    {
                        _id: {
                            $in: idsForFullRoles
                        }
                    },
                    {
                        $push: {
                            companies: this._id,
                            roles: {
                                active: "active",
                                unsuccessfulLogins: 0,
                                lockedOutUntil: null,
                                lastLogin: null,
                                rolesCount: allRoleIds.length,
                                roles: allRoleIds,
                                company: this._id
                            }
                        }
                    },
                    {session}
                );
            }

        }

        logger.finish(`Finished creating/updating company roles for company named '${this.name}' with VAT '${this.vat}'!`);
    }
    catch (e){
        console.log(e);
        logger.err(`Failed to create/update company roles for company named '${this.name}' with VAT '${this.vat}'!`);
        logger.fail("Failed to create/update company roles for company named '" + this.name + "' with VAT '" + this.vat + "'!");
    }
}

CompanySchema.methods.assignCreatorFinanceAndRoles = async function (session?: ClientSession | null) {
    const creatorId = documentObjectId(this.createdBy);
    if (!creatorId) {
        return;
    }

    const adminRole = session
        ? await Role.findOne({company: this._id, isAdmin: true}).session(session)
        : await Role.findOne({company: this._id, isAdmin: true});

    if (!adminRole) {
        throw new Error(`assignCreatorFinanceAndRoles: admin role not found for company ${this._id.toString()}`);
    }

    const currencyQuery = Currency.find({});
    const currencies = session ? await currencyQuery.session(session) : await currencyQuery;

    const financeCurrencies: FinanceCurrencies[] = currencies.map((currency) => ({
        currency: currency._id,
        amount: Decimal128.fromString("999999999.99"),
    }));

    const saveOpts = session ? {session} : {};
    const newFinance = await new Finance({
        currencies: financeCurrencies,
        company: this._id,
    }).save(saveOpts);

    const userQuery = User.findById(creatorId);
    const creatorUser = session ? await userQuery.session(session) : await userQuery;

    if (!creatorUser) {
        throw new Error(`assignCreatorFinanceAndRoles: creator user not found ${creatorId.toString()}`);
    }

    const newCompanyRole: IEmbeddedCompanyRole = {
        _id: new ObjectId(),
        active: "active",
        unsuccessfulLogins: 0,
        lockedOutUntil: null,
        lastLogin: null,
        rolesCount: 1,
        roles: [adminRole._id] as unknown as IEmbeddedCompanyRole["roles"],
        company: this._id as unknown as IEmbeddedCompanyRole["company"],
    };

    creatorUser.companies.push(this._id as never);
    creatorUser.finance.push(newFinance._id as never);
    creatorUser.roles.push(newCompanyRole as never);
    creatorUser.$locals = creatorUser.$locals || {};
    creatorUser.$locals.auditUserId = creatorId;
    await creatorUser.save(saveOpts);
};

CompanySchema.methods.addCompanyDemoData = async function (parentLogger?: serverLogger){

    let logger =  getLogger("adding_company_demo_data", parentLogger);
    logger.start(`Adding company demo data for company named '${this.name}' with VAT '${this.vat}'...`);

    try{
        logger.debug(`Adding currencies, countries, states and cities...`);
        await createCurrencies(logger, this);
        await createCountries(logger, this);
        await createStates(logger, this);
        await createCities(logger, this);
        logger.debug(`Added currencies, countries, states and cities!`);
    }catch (e){
        console.log(e);
        logger.fail("Failed to add company demo data for company named '" + this.name + "' with VAT '" + this.vat + "'!");
    }

    try{
        logger.debug(`Adding optional module demo data...`);
        await runModuleCompanyDemoSeeds(logger, this);
        logger.debug(`Added optional module demo data!`);
    }catch (e){
        console.log(e);
        logger.fail("Failed to add module demo data for company named '" + this.name + "' with VAT '" + this.vat + "'!");
    }

    logger.finish(`Finished adding company demo data for company named '${this.name}' with VAT '${this.vat}'!`);
}

CompanySchema.methods.createBot = async function (){
    let possibleBot = await User.findOne({
        companies: {$in: [this._id]},
        isBot: true
    })
    if( !!possibleBot ){
        return;
    }
    let financeCurrencies: FinanceCurrencies[] = (await Currency.find({})).map( currency => {
        return {
            currency: currency._id,
            amount: Decimal128.fromString("999999999.99")
        }
    });

    let newFinance = await new Finance({
        currencies: financeCurrencies,
        company: this._id
    }).save();

    let createdBotUser = await new User({
        username: `${this.name.replaceAll(" ", "")} AI Bot`,
        password: generateRandomString(64),
        isBot: true,
        mfaSecret: "",
        unsuccessfulLogins: 0,
        online: false,
        name: `${this.name.replaceAll(" ", "")} AI`,
        surname: "Bot",
        fullName: `${this.name.replaceAll(" ", "")} AI Bot`,
        email: `bot_${this.name.replaceAll(" ", "")}`,
        verifiedEmail: true,
        timezone: "Europe/Berlin",
        birthday: "2000-01-01",
        phoneNumber: "+000000000000",
        companies: [this._id],
        finance: [newFinance._id],
        roles: [
            {
                active: "active",
                unsuccessfulLogins: 0,
                lockedOutUntil: null,
                lastLogin: null,
                rolesCount: 0,
                roles: [],
                company: this._id
            }
        ],
        // ===================================
        currencyConfiguration: [],
        telegram: {
            runProtocols: false,
            chatId: null
        },
    }).save();
    await User.findByIdAndUpdate(createdBotUser._id, {registeredFrom: createdBotUser._id});

}
/**
 * Ensures every non-bot user with an active role in this company has their single
 * 1-1 AI-assistant channel with the company bot. Idempotent; safe to re-run.
 * Requires the bot user to already exist (see createBot).
 */
CompanySchema.methods.ensureAiChannels = async function (session?: ClientSession | null) {
    const query = User.find({
        companies: this._id,
        isBot: {$ne: true},
        "roles.company": this._id,
        "roles.active": "active",
    }).select("_id");
    const companyRoleUsers = session ? await query.session(session) : await query;

    const auditUserId = documentObjectId(this.createdBy) ?? undefined;
    for (const user of companyRoleUsers) {
        await ensureAiChannel({
            userId: user._id,
            companyId: this._id,
            session: session ?? null,
            auditUserId,
        });
    }
};

CompanySchema.methods.getRobotId = async function (): Promise<ObjectId>{
    let robotAggregate = await User.findOne({
        isBot: true,
        companies: {$in: [this._id]}
    });
    return robotAggregate?._id || null;
}
CompanySchema.methods.getAllRoles = async function (fetchAdminRoles: boolean = false): Promise<IRole[]>{
    let filter = {
        company: this._id,
    }
    if( !fetchAdminRoles ){
        filter["isAdmin"] = false;
    }
    return Role.find(filter);
}

ownershipPlugin(CompanySchema);
auditPlugin(CompanySchema);
softDeletePlugin(CompanySchema);
applyCompanyIndexes(CompanySchema);
const Company = mongoose.model<ICompany>('Company', CompanySchema);
normalizeSchemaPermissions(Company);
export default Company;

addModelData(Company, companyViews);
validateSchemaDefAgainstMongoose(CompanySchema, CompanySchemaDef, "Company", ["isDefaultForSignUp", "propertyManagementSettings"]);


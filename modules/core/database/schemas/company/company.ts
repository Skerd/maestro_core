import mongoose, {Document, Schema, SchemaTypes} from 'mongoose';
import {ClientSession, ObjectId} from "mongodb";
import Role, {IRole} from "@coreModule/database/schemas/role/role";
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
import publicMediaPlugin from "@coreModule/database/plugins/publicMediaPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import {
    ILifeCyclePluginFields,
    IOwnershipPluginFields,
    ISoftDeletePluginFields
} from "@coreModule/database/types/plugin-fields";
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
import {
    DEFAULT_ROLE_SLUG_PATTERN,
    defaultRoleSlug,
    groupDefaultRoles,
    getDefaultRolesForModules,
    resolveDefaultRolePermissionIds,
    roleHasPermissionPack,
    type DefaultRoleDefinition,
} from "@coreModule/database/schemas/role/role.defaults";
import {ensureModuleDefaultRolesRegistered} from "@coreModule/utilities/modules/ensureModuleDefaultRoles";
import {seedCronJobsForCompany} from "@coreModule/cronjobs/bootstrap/seedCompanyJobs";
import {runModuleCompanyDemoSeeds} from "@coreModule/utilities/modules/runModuleCompanyDemoSeeds";
import {seedCoreDemoData} from "@coreModule/database/demo/coreCompanyDemo";
import {validateSchemaDefAgainstMongoose} from "@coreModule/database/utilities/validateSchemaDefAgainstMongoose";
import {COMPANY_TIMEZONE_MAX, CompanySchemaDef} from "armonia/src/modules/core/api/company/private/company/company.schema-def";
import {
    SITE_PROVISION_STATUSES,
    SITE_SLUG_MAX,
    type SiteProvisionStatus,
} from "armonia/src/modules/core/api/company/private/company/siteSlug";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";
import {closeCompanyModules, effectiveCompanyModules, invalidateCompanyModules} from "@coreModule/utilities/modules/companyModules";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {checkTenantReferences} from "@coreModule/database/plugins/tenantReferences";

function documentObjectId(ref: unknown): ObjectId | null {
    if (ref == null) return null;
    if (ref instanceof ObjectId) return ref;
    if (typeof ref === "object" && "_id" in ref && (ref as {_id: unknown})._id instanceof ObjectId) {
        return (ref as {_id: ObjectId})._id;
    }
    return null;
}

function rolePermissionId(permission: unknown): ObjectId | null {
    if (permission instanceof ObjectId) {
        return permission;
    }
    return documentObjectId(permission);
}

export interface ICompany extends Document, IOwnershipPluginFields, ISoftDeletePluginFields, ILifeCyclePluginFields {
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
    linkedin?: string;
    instagram?: string;
    facebook?: string;
    vat: string;
    siteSlug?: string;
    /** IANA zone the company's business days are evaluated in (D91); resolve it with `companyTimeZone`. */
    timezone?: string;
    siteHost?: string;
    siteProvision?: {
        status: SiteProvisionStatus;
        checkedAt?: Date;
        lastError?: string;
        steps: {
            slug: boolean;
            domain: boolean;
            reachable: boolean;
        };
    };
    parentCompany?: ICompany;
    isActive: boolean;
    isDefaultForSignUp: boolean;
    allowedDomains: string[];
    /** Granted modules (dependency-closed). Unset = every installed module. See companyModules.ts. */
    modules?: string[];
    /** Admins of this company manage every company's modules. At most one company. */
    isPlatformOwner: boolean;
    /** Set by the platform owner: the company is left off the portal and the shop apex. */
    hiddenFromPortal: boolean;
    /** The company's own opt-in to list its shop on the portal and the shop apex. */
    shopListedOnPortal: boolean;
    publicAiChat?: {
        enabled: boolean;
        greeting?: string;
        persona?: string;
        requireIdentification: boolean;
        humanHandoffEnabled: boolean;
    };
    createBot: (session?: ClientSession | null) => Promise<void>;
    ensureAiChannels: (session?: ClientSession | null) => Promise<void>;
    seedCronJobs: (session?: ClientSession | null) => Promise<void>;
    getRobotId: (session?: ClientSession | null) => Promise<ObjectId | null>;
    createDefaultRoles: (parentLogger?: serverLogger, session?: ClientSession) => Promise<void>;
    assignCreatorRoles: (session?: ClientSession | null) => Promise<void>;
    addCompanyDemoData: (parentLogger?: serverLogger, session?: ClientSession) => Promise<void>;
    getAllRoles: (fetchAdminRoles?: boolean) => Promise<IRole[]>;
}

export interface ICompanyModel extends mongoose.Model<ICompany> {
    findRobotId(companyId: ObjectId, session?: ClientSession | null): Promise<ObjectId | null>;
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
        linkedin: {
            type: SchemaTypes.String
        },
        instagram: {
            type: SchemaTypes.String
        },
        facebook: {
            type: SchemaTypes.String
        },
        vat: {
            type: SchemaTypes.String,
            required: true,
            unique: true
        },
        siteSlug: {
            type: SchemaTypes.String,
            trim: true,
            lowercase: true,
            maxlength: SITE_SLUG_MAX,
        },
        timezone: {
            type: SchemaTypes.String,
            trim: true,
            maxlength: COMPANY_TIMEZONE_MAX,
        },
        siteHost: {
            type: SchemaTypes.String,
            trim: true,
            lowercase: true,
            permissions: {
                self: {write: "no-permission"},
                others: {write: "no-permission"},
            },
        },
        siteProvision: {
            type: {
                status: {
                    type: SchemaTypes.String,
                    enum: SITE_PROVISION_STATUSES,
                },
                checkedAt: {
                    type: SchemaTypes.Date,
                },
                lastError: {
                    type: SchemaTypes.String,
                },
                steps: {
                    slug: {type: SchemaTypes.Boolean, default: false},
                    domain: {type: SchemaTypes.Boolean, default: false},
                    reachable: {type: SchemaTypes.Boolean, default: false},
                },
            },
            required: false,
            permissions: {
                self: {write: "no-permission"},
                others: {write: "no-permission"},
            },
        },
        parentCompany: {
            type: Schema.Types.ObjectId,
            ref: "Company",
            default: null,
            refAllowlist: CompanyBlankSnippet,
            dynamicTableConfiguration: {
                refDisplayKey: ["name", "vat"],
            },
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
        modules: {
            type: [SchemaTypes.String],
            default: undefined,
            permissions: {
                self: {write: "no-permission"},
                others: {write: "no-permission"},
            },
        },
        isPlatformOwner: {
            type: SchemaTypes.Boolean,
            default: false,
            permissions: {
                self: {write: "no-permission"},
                others: {write: "no-permission"},
            },
        },
        hiddenFromPortal: {
            type: SchemaTypes.Boolean,
            default: false,
            permissions: {
                self: {write: "no-permission"},
                others: {write: "no-permission"},
            },
        },
        shopListedOnPortal: {
            type: SchemaTypes.Boolean,
            default: false,
        },
        publicAiChat: {
            type: {
                enabled: {
                    type: SchemaTypes.Boolean, 
                    default: false
                },
                greeting: {
                    type: SchemaTypes.String, 
                    required: false, 
                    maxlength: 500
                },
                persona: {
                    type: SchemaTypes.String, 
                    required: false, 
                    maxlength: 2000
                },
                requireIdentification: {
                    type: SchemaTypes.Boolean, 
                    default: false
                },
                humanHandoffEnabled: {
                    type: SchemaTypes.Boolean, 
                    default: true
                }
            },
            required: false,
            default: () => ({
                enabled: false,
                requireIdentification: false,
                humanHandoffEnabled: true
            })
        },
    },
    {
        accessMode: "loose",
    }
);

CompanySchema.pre("save", function (next) {
    this.$locals = this.$locals || {};
    this.$locals.companyWasNew = this.isNew;
    this.$locals.modulesChanged = !this.isNew && (this.isModified("modules") || this.isModified("isActive"));
    // Stored dependency-closed, so `{modules: "<name>"}` queries match every company that has it.
    if (this.isModified("modules") && Array.isArray(this.modules)) {
        this.modules = closeCompanyModules(this.modules);
    }
    next();
});

CompanySchema.post("save", async function (doc) {
    if (doc.$locals.modulesChanged) {
        await invalidateCompanyModules(String(doc._id));
    }
    if (doc.$locals.companyWasNew) {
        const session = doc.$session();
        // The new company's roles, bot, channels and jobs are its own data, not the creator's (D16).
        await withTenant(String(doc._id), async () => {
            await doc.createDefaultRoles(undefined, session ?? undefined);
            await doc.assignCreatorRoles(session);
            await doc.createBot(session);
            await doc.ensureAiChannels(session ?? undefined);
            await doc.seedCronJobs(session ?? undefined);
        });
    }
});

CompanySchema.methods.createDefaultRoles = async function (parentLogger?: serverLogger, session?: ClientSession){
    // Also run at boot for every company, outside any request (D16).
    return withTenant(this._id, () => createDefaultRolesFor.call(this, parentLogger, session));
};

async function createDefaultRolesFor(this: ICompany, parentLogger?: serverLogger, session?: ClientSession){

    let logger =  getLogger("creating/updating_company_default_roles", parentLogger);
    logger.start(`Creating/updating company roles for company named '${this.name}' with VAT '${this.vat}'...`);

    try{
        await ensureModuleDefaultRolesRegistered(logger);
        const seededRoles = getDefaultRolesForModules(effectiveCompanyModules(this));

        if( seededRoles.length === 0 ){
            logger.debug(`No default roles found`);
        }
        else {
            const definitionBySlug = new Map<string, DefaultRoleDefinition>(
                seededRoles.map((role) => [defaultRoleSlug(this.name, role), role])
            );

            // Found by suffix: a role made under the company's former name is the same role, and
            // takes the current name's slug instead of a second set being created.
            const companyRoles = await Role.find({company: this._id, slug: DEFAULT_ROLE_SLUG_PATTERN})
                .sort({createdAt: 1})
                .session(session ?? null);
            const savedRoles: typeof companyRoles = [];
            const rolesToCreate: DefaultRoleDefinition[] = [];
            for (const [definition, matches] of groupDefaultRoles(companyRoles, seededRoles)) {
                const slug = defaultRoleSlug(this.name, definition);
                const kept = matches.find((role) => role.slug === slug) ?? matches[0];
                if (!kept) {
                    rolesToCreate.push(definition);
                    continue;
                }
                if (kept.slug !== slug) {
                    logger.debug(`Role '${kept.slug}' follows the company's new name: '${slug}'`);
                    kept.slug = slug;
                    await kept.save({session});
                }
                savedRoles.push(kept);
            }

            for (const savedRole of savedRoles) {
                const definition = definitionBySlug.get(savedRole.slug);
                if (!definition) {
                    continue;
                }
                let dirty = false;
                if (definition.description && !(savedRole.description || "").trim()) {
                    savedRole.description = definition.description;
                    dirty = true;
                }
                if (definition.isAdmin) {
                    const existingIds = savedRole.permissions
                        .map((permission) => rolePermissionId(permission))
                        .filter((id): id is ObjectId => id != null);
                    const missingPermissions = await RolePermission.find(
                        {_id: {$nin: existingIds}}
                    ).select("_id").session(session ?? null);
                    if (missingPermissions.length > 0) {
                        savedRole.permissions = [...savedRole.permissions, ...missingPermissions];
                        dirty = true;
                    }
                    if (dirty) {
                        await savedRole.save({session});
                    }
                    logger.debug(`The company admin role named '${savedRole.name}' with slug '${savedRole.slug}' already exists. Updated [permissions]`);
                    continue;
                }
                if (!roleHasPermissionPack(definition)) {
                    if (dirty) {
                        await savedRole.save({session});
                    }
                    continue;
                }
                const packIds = await resolveDefaultRolePermissionIds(definition, session);
                const existing = new Set(
                    savedRole.permissions
                        .map((permission) => rolePermissionId(permission)?.toString())
                        .filter((id): id is string => !!id)
                );
                const missing = packIds.filter((id) => !existing.has(id.toString()));
                if (missing.length > 0) {
                    savedRole.permissions = [...savedRole.permissions, ...missing] as IRole["permissions"];
                    dirty = true;
                    logger.debug(`Updated workflow role named '${savedRole.name}' with ${missing.length} permission(s)`);
                }
                if (dirty) {
                    await savedRole.save({session});
                }
            }

            for( let role of rolesToCreate ){
                const permissions = role.isAdmin
                    ? await RolePermission.find().select("_id").session(session ?? null)
                    : await resolveDefaultRolePermissionIds(role, session);
                await new Role({
                    _id: new ObjectId(),
                    company: this._id,
                    createdBy: this.createdBy,
                    name: role.name,
                    description: role.description || "",
                    slug: defaultRoleSlug(this.name, role),
                    isAdmin: role.isAdmin,
                    isSignupDefault: role.isSignupDefault,
                    canEdit: role.canEdit,
                    canDelete: role.canDelete,
                    permissions: permissions as IRole["permissions"],
                }).save({session});
                logger.debug(`Created role named '${role.name}' with slug '${role.slug}'`);
            }

        }

        logger.finish(`Finished creating/updating company roles for company named '${this.name}' with VAT '${this.vat}'!`);
    }
    catch (e){
        logger.err(`Failed to create/update company roles for company named '${this.name}' with VAT '${this.vat}'!: ${e instanceof Error ? e.message : String(e)}`);
        logger.fail("Failed to create/update company roles for company named '" + this.name + "' with VAT '" + this.vat + "'!");
    }
}

CompanySchema.methods.assignCreatorRoles = async function (session?: ClientSession | null) {
    const creatorId = documentObjectId(this.createdBy);
    if (!creatorId) {
        return;
    }

    const adminRole = session
        ? await Role.findOne({company: this._id, isAdmin: true}).session(session)
        : await Role.findOne({company: this._id, isAdmin: true});

    if (!adminRole) {
        throw new Error(`assignCreatorRoles: admin role not found for company ${this._id.toString()}`);
    }

    const saveOpts = session ? {session} : {};

    const userQuery = User.findById(creatorId);
    const creatorUser = session ? await userQuery.session(session) : await userQuery;

    if (!creatorUser) {
        throw new Error(`assignCreatorRoles: creator user not found ${creatorId.toString()}`);
    }

    const newCompanyRole: IEmbeddedCompanyRole = {
        _id: new ObjectId(),
        active: "active",
        unsuccessfulLogins: 0,
        lockedOutUntil: null,
        lastLogin: null,
        rolesCount: 1,
        roles: [adminRole._id],
        company: this._id,
    };

    creatorUser.companies.push(this._id as never);
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
        logger.err(e instanceof Error ? (e.stack ?? e.message) : String(e));
        logger.fail("Failed to add company demo data for company named '" + this.name + "' with VAT '" + this.vat + "'!");
    }

    try{
        logger.debug(`Adding core demo data...`);
        await seedCoreDemoData(logger, this);
        logger.debug(`Added core demo data!`);
    }catch (e){
        logger.err(e instanceof Error ? (e.stack ?? e.message) : String(e));
        logger.fail("Failed to add core demo data for company named '" + this.name + "' with VAT '" + this.vat + "'!");
    }

    try{
        logger.debug(`Adding optional module demo data...`);
        await runModuleCompanyDemoSeeds(logger, this);
        logger.debug(`Added optional module demo data!`);
    }catch (e){
        logger.err(e instanceof Error ? (e.stack ?? e.message) : String(e));
        logger.fail("Failed to add module demo data for company named '" + this.name + "' with VAT '" + this.vat + "'!");
    }

    logger.finish(`Finished adding company demo data for company named '${this.name}' with VAT '${this.vat}'!`);
}

CompanySchema.methods.createBot = async function (session?: ClientSession | null){
    const existingQuery = User.findOne({
        companies: {$in: [this._id]},
        isBot: true
    });
    const possibleBot = session ? await existingQuery.session(session) : await existingQuery;
    if( possibleBot ){
        return;
    }
    const botId = new ObjectId();
    const createdBotUser = new User({
        _id: botId,
        registeredFrom: botId,
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
        currencyConfiguration: [],
        telegram: {
            runProtocols: false,
            chatId: null
        },
    });
    await createdBotUser.save(session ? {session} : undefined);
}
/**
 * Ensures every non-bot user with an active role in this company has their single
 * 1-1 AI-assistant channel with the company bot. Idempotent; safe to re-run.
 * Requires the bot user to already exist (see createBot).
 */
CompanySchema.methods.ensureAiChannels = async function (session?: ClientSession | null) {
    const {ensureAiChannel} = await import("@coreModule/database/schemas/channel/channel.helper");
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

CompanySchema.methods.seedCronJobs = async function (session?: ClientSession | null) {
    await seedCronJobsForCompany(this._id, effectiveCompanyModules(this), session ?? undefined);
};

CompanySchema.statics.findRobotId = async function (
    companyId: ObjectId,
    session?: ClientSession | null,
): Promise<ObjectId | null> {
    const q = User.findOne({isBot: true, companies: {$in: [companyId]}}).select("_id");
    const bot = session ? await q.session(session) : await q;
    return bot?._id ?? null;
};

CompanySchema.methods.getRobotId = async function (session?: ClientSession | null): Promise<ObjectId | null> {
    return (this.constructor as ICompanyModel).findRobotId(this._id, session);
};
CompanySchema.methods.getAllRoles = async function (fetchAdminRoles: boolean = false): Promise<IRole[]>{
    let filter = {
        company: this._id,
    }
    if( !fetchAdminRoles ){
        filter["isAdmin"] = false;
    }
    return Role.find(filter);
}

// `company` here is the parent company that created this one, not a tenant partition (D16).
ownershipPlugin(CompanySchema, {tenantScoped: false});
// Its addresses' places and its logo are its own rows (D104): `company` names the parent, so they are judged by `_id`.
checkTenantReferences(CompanySchema, "_id");
publicMediaPlugin(CompanySchema, {schemaDef: CompanySchemaDef, companyFromDocumentId: true});
auditPlugin(CompanySchema);
softDeletePlugin(CompanySchema);
lifeCyclePlugin(CompanySchema);
applyCompanyIndexes(CompanySchema);
const Company = mongoose.model<ICompany, ICompanyModel>('Company', CompanySchema);
normalizeSchemaPermissions(Company);
export default Company;

addModelData(Company, companyViews);
validateSchemaDefAgainstMongoose(CompanySchema, CompanySchemaDef, "Company", ["isDefaultForSignUp", "modules", "isPlatformOwner", "hiddenFromPortal"]);


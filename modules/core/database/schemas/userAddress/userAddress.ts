import {Document, model, Schema, SchemaTypes} from "mongoose";
import {ICompany} from "@coreModule/database/schemas/company/company";
import {IUser} from "@coreModule/database/schemas/user/user";
import {ICountry} from "@coreModule/database/schemas/country/country";
import {IState} from "@coreModule/database/schemas/state/state";
import {ICity} from "@coreModule/database/schemas/city/city";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import ownershipPlugin from "@coreModule/database/plugins/ownershipPlugin";
import auditPlugin from "@coreModule/database/plugins/auditPlugin";
import softDeletePlugin from "@coreModule/database/plugins/softDeletePlugin";
import {
    ILifeCyclePluginFields,
    IOwnershipPluginFields,
    ISoftDeletePluginFields
} from "@coreModule/database/types/plugin-fields";
import {addModelData} from "@coreModule/database/collections";
import {validateSchemaDefAgainstMongoose} from "@coreModule/database/utilities/validateSchemaDefAgainstMongoose";
import {UserAddressSchemaDef, userAddressTypes, type UserAddressType} from "armonia/src/modules/core/api/user/private/userAddress/userAddress.schema-def";
import {SimpleUserSnippet} from "@coreModule/database/schemas/user/user.snippets";
import {CountrySimpleSnippet} from "@coreModule/database/schemas/country/country.snippets";
import {StateSimpleSnippet} from "@coreModule/database/schemas/state/state.snippets";
import {CitySimpleSnippet} from "@coreModule/database/schemas/city/city.snippets";
import {applyUserAddressIndexes} from "./userAddress.indexes";
import {userAddressViews} from "./userAddress.views";
import lifeCyclePlugin from "@coreModule/database/plugins/lifeCyclePlugin";

/**
 * A person's saved address (D163): one address book per person, shown on every site they sign in to. Rows live in the
 * platform company (which every instance has, with core only); the routes in `api/user/private/userAddress.ts` read and
 * write only the signed-in person's rows. A shop sees a buyer's address through its order's copy, and its staff read
 * their buyers' books through eCommerce's read-only customer addresses page.
 */
export interface IUserAddress extends Document, IOwnershipPluginFields, ISoftDeletePluginFields, ILifeCyclePluginFields {
    user: IUser;
    type: UserAddressType;
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    street: string;
    city: ICity;
    state?: IState;
    postalCode?: string;
    country: ICountry;
    latitude: number;
    longitude: number;
    isDefault: boolean;
    label?: string;
}

const UserAddressSchema = new Schema<IUserAddress>(
    {
        // The book's owner, set by the server from the session and never changed (D163).
        user: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            required: true,
            immutable: true,
            refAllowlist: SimpleUserSnippet,
        },
        type: {
            type: SchemaTypes.String,
            enum: [...userAddressTypes],
            required: true,
            default: "shipping",
            dynamicTableConfiguration: {
                enumTones: {
                    billing: "info",
                    shipping: "success",
                },
            },
        },
        firstName: {
            type: SchemaTypes.String, 
            required: true, 
            trim: true
        },
        lastName: {
            type: SchemaTypes.String, 
            required: true, 
            trim: true
        },
        email: {
            type: SchemaTypes.String,
            trim: true,
            lowercase: true,
        },
        phone: {
            type: SchemaTypes.String, 
            trim: true
        },
        street: {
            type: SchemaTypes.String, 
            required: true, 
            trim: true
        },
        city: {
            type: SchemaTypes.ObjectId, 
            ref: "City", 
            required: true, 
            refAllowlist: CitySimpleSnippet
        },
        state: {
            type: SchemaTypes.ObjectId, 
            ref: "State", 
            refAllowlist: StateSimpleSnippet
        },
        postalCode: {
            type: SchemaTypes.String, 
            trim: true
        },
        country: {
            type: SchemaTypes.ObjectId, 
            ref: "Country", 
            required: true, 
            refAllowlist: CountrySimpleSnippet
        },
        latitude: {
            type: SchemaTypes.Number, 
            required: true,
            dynamicTableConfiguration: {hideColumn: true},
        },
        longitude: {
            type: SchemaTypes.Number, 
            required: true,
            dynamicTableConfiguration: {hideColumn: true},
        },
        isDefault: {
            type: SchemaTypes.Boolean, 
            default: false
        },
        label: {
            type: SchemaTypes.String, 
            trim: true
        },
    },
    {accessMode: "loose"},
);

// Not tenant-scoped: every row is stored in the platform company and every query names its rows (D163).
ownershipPlugin(UserAddressSchema, {tenantScoped: false});
auditPlugin(UserAddressSchema);
softDeletePlugin(UserAddressSchema);
lifeCyclePlugin(UserAddressSchema);
applyUserAddressIndexes(UserAddressSchema);
const UserAddress = model<IUserAddress>("UserAddress", UserAddressSchema);
normalizeSchemaPermissions(UserAddress);
export default UserAddress;

addModelData(UserAddress, userAddressViews);
validateSchemaDefAgainstMongoose(UserAddressSchema, UserAddressSchemaDef, "UserAddress");

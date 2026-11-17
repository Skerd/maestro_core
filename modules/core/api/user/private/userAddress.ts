import {ObjectId} from "mongodb";
import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import {buildCreateDataFromSchemaDef, buildUpdateDataFromSchemaDef} from "@coreModule/api/buildUpdateDataFromSchemaDef";
import {UserAddressSchemaDef} from "armonia/src/modules/core/api/user/private/userAddress/userAddress.schema-def";
import {createUserAddressFormSchema} from "armonia/src/modules/core/api/user/private/userAddress/createUserAddress.form.validator";
import {editUserAddressFormSchema} from "armonia/src/modules/core/api/user/private/userAddress/editUserAddress.form.validator";
import {userAddressFormSchema} from "armonia/src/modules/core/api/user/private/userAddress/userAddress.form.validator";
import {
    myUserAddressCreateFormSchema,
    myUserAddressEditFormSchema,
} from "armonia/src/modules/core/api/user/private/userAddress/myUserAddress.form.validator";
import type {
    MyUserAddressCreateFormType,
    MyUserAddressEditFormType,
} from "armonia/src/modules/core/api/user/private/userAddress/myUserAddress.form.validator";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import type {ClientSession} from "mongoose";
import UserAddress from "@coreModule/database/schemas/userAddress/userAddress";
import {userAddressService} from "@coreModule/database/schemas/userAddress/userAddress.service";
import {UserAddressActions} from "@coreModule/database/schemas/userAddress/userAddress.actions";
import {userAddressToDTO, userAddressesToDTO} from "@coreModule/utilities/mappers/userAddress/userAddressMapper.dto";
import {userAddressesToSelect} from "@coreModule/utilities/mappers/userAddress/userAddressMapper.select";
import authMW, {type AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import type {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";

/** The signed-in person (or the user an admin acts as) owns the book every route reads and writes (D163). */
const ownBook = (params: AuthenticatedMWType) => userAddressService.bookClause([params.actionUserCtx.userId]);

/**
 * A person's address book (D163): stored in the platform company, shown on every site they sign in to. The panel's
 * account tab uses the CRUD routes, storefronts the `/my` routes; both only ever reach the caller's own rows.
 */
export const basePath = "/api/user/userAddress";

export const {router} = createCrudRouter({
    collectionName: "userAddresses",
    model: UserAddress,
    service: userAddressService,
    entityName: "UserAddress",
    defaultSort: {isDefault: -1, createdAt: -1},
    createSchema: createUserAddressFormSchema,
    editSchema: editUserAddressFormSchema,
    listSchema: userAddressFormSchema,
    toDTO: userAddressToDTO,
    toDTOArray: userAddressesToDTO,
    toSelect: userAddressesToSelect,
    documentFilter: ownBook,
    buildCreateData: async (params) => {
        return {
            ...buildCreateDataFromSchemaDef(UserAddressSchemaDef)(params),
            user: new ObjectId(params.actionUserCtx.userId),
            company: await userAddressService.bookCompanyOrThrow(params.languageCode),
        };
    },
    buildUpdateData: buildUpdateDataFromSchemaDef(UserAddressSchemaDef),
    overrideSelectHandler: async (params) => {
        const filter = await ownBook(params);
        const [docs, total] = await Promise.all([
            userAddressService.find(filter, params, ["city"], undefined, {isDefault: -1, createdAt: -1}, params.limit, (params.page - 1) * params.limit),
            userAddressService.count(filter, params),
        ]);
        return {data: userAddressesToSelect(docs), total};
    },
    actions: UserAddressActions,
    rateLimits: {read: 60, write: 30, delete: 20},
});

const ADDRESS_POPULATE = ["city", "state", "country", "user"];

async function clearOtherDefaults(
    params: AuthenticatedMWType & {session?: unknown; type: string; keepId?: ObjectId},
): Promise<void> {
    await userAddressService.updateMany(
        {
            ...(await ownBook(params)),
            type: params.type,
            isDefault: true,
            ...(params.keepId ? {_id: {$ne: params.keepId}} : {}),
        },
        {$set: {isDefault: false}},
        {session: params.session as ClientSession | undefined},
    );
}

async function ownAddressFilter(params: AuthenticatedMWType, _id?: string) {
    return {
        ...(await ownBook(params)),
        ...(_id ? {_id: new ObjectId(_id)} : {}),
    };
}

router.post(
    "/my",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(async (params: AuthenticatedMWType) => {
        const {logger, languageCode} = params;
        const addresses = await userAddressService.find(
            await ownAddressFilter(params),
            {logger, languageCode, withDeleted: false},
            ADDRESS_POPULATE,
            undefined,
            {isDefault: -1, createdAt: -1},
        );
        return {data: userAddressesToDTO(addresses)};
    }),
);

router.put(
    "/my",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 30}),
    validateFormZod(myUserAddressCreateFormSchema),
    transactionHandler(),
    asyncHandler(async (params: TransactionRequiredParams & MyUserAddressCreateFormType) => {
        const {logger, languageCode, session, actionUserCtx} = params;
        const type = params.type ?? "shipping";
        if (params.isDefault) {
            await clearOtherDefaults({...params, type});
        }
        const created = await userAddressService.create(
            {
                user: new ObjectId(actionUserCtx.userId),
                type,
                firstName: params.firstName,
                lastName: params.lastName,
                email: params.email,
                phone: params.phone,
                street: params.street,
                city: new ObjectId(params.city),
                ...(params.state ? {state: new ObjectId(params.state)} : {}),
                postalCode: params.postalCode,
                country: new ObjectId(params.country),
                latitude: params.latitude ?? 0,
                longitude: params.longitude ?? 0,
                label: params.label,
                isDefault: params.isDefault ?? false,
                company: await userAddressService.bookCompanyOrThrow(languageCode),
            },
            {logger, languageCode, session, auditUserId: actionUserCtx.userId},
        );
        const populated = await userAddressService.findById(
            created._id,
            {logger, languageCode, session},
            ADDRESS_POPULATE,
        );
        return {data: userAddressToDTO(populated ?? created)};
    }),
);

router.patch(
    "/my",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 30}),
    validateFormZod(myUserAddressEditFormSchema),
    transactionHandler(),
    asyncHandler(async (params: TransactionRequiredParams & MyUserAddressEditFormType) => {
        const {logger, languageCode, session, _id} = params;
        const existing = await userAddressService.findOne(
            await ownAddressFilter(params, _id),
            {logger, languageCode, session, withDeleted: false},
        );
        if (!existing) {
            throw apiValidationException("user_address_not_found", "", null, languageCode);
        }
        const type = params.type ?? existing.type;
        if (params.isDefault) {
            await clearOtherDefaults({...params, type, keepId: existing._id});
        }
        existing.set({
            type,
            firstName: params.firstName,
            lastName: params.lastName,
            email: params.email,
            phone: params.phone,
            street: params.street,
            city: new ObjectId(params.city),
            state: params.state ? new ObjectId(params.state) : undefined,
            postalCode: params.postalCode,
            country: new ObjectId(params.country),
            latitude: params.latitude ?? existing.latitude,
            longitude: params.longitude ?? existing.longitude,
            label: params.label,
            isDefault: params.isDefault ?? existing.isDefault,
        });
        existing.$locals = existing.$locals || {};
        existing.$locals.auditUserId = new ObjectId(params.actionUserCtx.userId);
        await existing.save({session});
        const populated = await userAddressService.findById(
            existing._id,
            {logger, languageCode, session},
            ADDRESS_POPULATE,
        );
        return {data: userAddressToDTO(populated ?? existing)};
    }),
);

router.delete(
    "/my",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 20}),
    validateFormZod(validateSingleForm),
    transactionHandler(),
    asyncHandler(async (params: TransactionRequiredParams & {_id: string}) => {
        const {logger, languageCode, session, _id} = params;
        const existing = await userAddressService.findOne(
            await ownAddressFilter(params, _id),
            {logger, languageCode, session, withDeleted: false},
        );
        if (!existing) {
            throw apiValidationException("user_address_not_found", "", null, languageCode);
        }
        await userAddressService.deleteById(existing._id, {
            logger,
            languageCode,
            session,
            auditUserId: params.actionUserCtx.userId,
        });
        return {data: {_id}};
    }),
);


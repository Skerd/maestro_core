import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {rolePermissionService} from "@coreModule/database/schemas/rolePermission/rolePermission.service";
import {roleService} from "@coreModule/database/schemas/role/role.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {rolesToDTO, roleToDTO} from "@coreModule/utilities/mappers/role/roleMapper.dto";
import {CreateRolesFormType} from "armonia/src/modules/core/api/company/private/roles/createRoles.form.type";
import {editRoleFormSchema} from "armonia/src/modules/core/api/company/private/roles/editRole.form.validator";
import {EditRoleFormType} from "armonia/src/modules/core/api/company/private/roles/editRole.form.type";
import {DeletedDataReadFields} from "armonia/src/modules/core/types";
import {PermissionsFormType} from "armonia/src/modules/core/api/company/private/roles/permissions.form.type";
import {getPermissionsFormSchema} from "armonia/src/modules/core/api/company/private/roles/permissions.form.validator";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import Role from "@coreModule/database/schemas/role/role";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {schemaSanitizer, SchemaSanitizerMWType} from "@coreModule/utilities/middlewares/schemaSanitizerMW";
import {dslFilterMW, DslFilterMWType} from "@coreModule/utilities/middlewares/dslFilterMW";
import {
    ActionMessage,
    DeleteForm,
    DeleteResponse,
    RestoreForm,
    RestoreResponse,
    SingleForm,
    TableResponse
} from "armonia/src/modules/core/types/shared.types";
import {
    validateDeleteForm,
    validateRestoreForm,
    validateSingleForm
} from "armonia/src/modules/core/utilities/zod/shared.validator";
import {roleFormSchema} from "armonia/src/modules/core/api/company/private/roles/role.form.validator";
import {RoleFormType} from "armonia/src/modules/core/api/company/private/roles/role.form.type";
import {CompanyRole} from "armonia/src/modules/core/api/company/private/roles/role.dto";
import {createRoleFormSchema} from "armonia/src/modules/core/api/company/private/roles/createRole.form.validator";
import {PermissionDto} from "armonia/src/modules/core/api/company/private/roles/permission.dto";

const router = Router();

router.post(
    "",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 60 }),
    validateFormZod(roleFormSchema),
    schemaSanitizer({ model: "roles", requiredModes: ["read"] }),
    dslFilterMW({ model: "roles" }),
    asyncHandler(getCompanyRoles)
);
type GetCompanyRolesType = AuthenticatedMWType & SchemaSanitizerMWType & DslFilterMWType;

async function getCompanyRoles(params: GetCompanyRolesType & RoleFormType): Promise<TableResponse<CompanyRole>> {
    const { languageCode, company, logger, limit, offset, sortBy, sortOrder, sanitizedReadFields, dslFilterQuery } = params;

    logger.start("Fetching company roles...");

    const populate = SchemaGuard.generatePopulate(sanitizedReadFields, Role.schema);
    const opts = { logger, languageCode };
    const filterQuery: Record<string, unknown> = { company: company._id };

    if (dslFilterQuery && Object.keys(dslFilterQuery).length > 0) {
        filterQuery.$and = [...((filterQuery.$and as unknown[]) ?? []), dslFilterQuery];
    }
    const skip = offset;

    const sort: Record<string, 1 | -1> = (sortBy && sortOrder) ? { [sortBy]: sortOrder === "asc" ? 1 : -1 } : { name: 1 };

    const [roles, total] = await Promise.all([
        roleService.find(
            filterQuery,
            opts,
            populate.populate,
            (populate.select || "") + " canDelete canEdit",
            sort,
            limit,
            skip
        ),
        roleService.count(filterQuery, opts)
    ]);

    const allPermissions = await rolePermissionService.find({}, opts, undefined, "_id group tag");
    const data = rolesToDTO(roles, allPermissions);

    logger.finish("Finished fetching company roles!");
    return { data, total };
}

router.post(
    "/single",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 60 }),
    validateFormZod(validateSingleForm),
    schemaSanitizer({ model: "roles", requiredModes: ["read"] }),
    asyncHandler(getRolesSingle)
);
type GetRolesSingleType = AuthenticatedMWType & SchemaSanitizerMWType & SingleForm;

async function getRolesSingle(params: GetRolesSingleType): Promise<CompanyRole> {
    const { logger, languageCode, _id, sanitizedReadFields, company } = params;

    logger.start("Fetching company role (single)...");

    const populate = SchemaGuard.generatePopulate(sanitizedReadFields, Role.schema);
    const opts = { logger, languageCode };
    const role = await roleService.findOneOrThrow(
        {
            _id: new ObjectId(_id),
            company: company._id
        },
        opts,
        populate.populate,
        (populate.select || "") + " canDelete canEdit"
    );

    const allPermissions = await rolePermissionService.find({}, opts, undefined, "_id group tag");
    logger.finish("Finished fetching company role (single)!");

    return roleToDTO(role, allPermissions);
}

router.put(
    "",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 60 }),
    validateFormZod(createRoleFormSchema),
    schemaSanitizer({ model: "roles", requiredModes: ["write"] }),
    transactionHandler(),
    asyncHandler(createCompanyRole)
);
type CreateCompanyRoleType = TransactionRequiredParams & AuthenticatedMWType & SchemaSanitizerMWType;

async function createCompanyRole(params: CreateCompanyRoleType & CreateRolesFormType): Promise<ActionMessage> {
    const { languageCode, company, logger, permissions, name, session, actionUserCtx } = params;

    logger.start(`Trying to create company role...`);
    SchemaGuard.checkModelPermission(Role, "create", actionUserCtx);

    const getRoleIds = Object.keys(permissions).filter((permissionId) => permissions[permissionId]);
    const foundPermissions = await rolePermissionService.find(
        { _id: { $in: getRoleIds } },
        { session, logger, languageCode },
        undefined,
        "_id"
    );
    let dbIds: ObjectId[] = foundPermissions.map((permission) => permission._id);

    await roleService.create(
        {
            company: company,
            isAdmin: false,
            slug: company.name.toLowerCase().replace(/ /g, "_") + ":" + name.toLowerCase().replace(/ /g, "_"),
            name,
            permissions: dbIds as any
        },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    logger.finish(`Finished creating company role!`);

    return {
        message: "Company role successfully created"
    };
}

router.patch(
    "",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 60 }),
    validateFormZod(editRoleFormSchema),
    schemaSanitizer({ model: "roles", requiredModes: ["write"] }),
    transactionHandler(),
    asyncHandler(updateCompanyRole)
);
type UpdateCompanyRoleType = TransactionRequiredParams & AuthenticatedMWType & SchemaSanitizerMWType;

async function updateCompanyRole(params: UpdateCompanyRoleType & EditRoleFormType): Promise<ActionMessage> {
    const { languageCode, company, logger, permissions, id, session, actionUserCtx, sanitizedWriteFields } = params;

    logger.start(`Trying to update company role...`);

    const companyRole = await roleService.findOneOrThrow(
        {
            _id: new ObjectId(id),
            company: new ObjectId(company._id),
            canEdit: true
        },
        { session, logger, languageCode },
        [{ path: "permissions", select: "_id" }]
    );

    if( sanitizedWriteFields.name ){ companyRole.name = params.name; }
    if( sanitizedWriteFields.permissions ){
        const alreadySavedPermissions = companyRole.permissions.map((permission) => permission._id.toString());
        const permissionChanges = Object.entries(permissions).reduce(
            (acc, [id, enabled]) => {
                if (enabled && !alreadySavedPermissions.includes(id)) {
                    acc.add.push(id);
                } else if (!enabled && alreadySavedPermissions.includes(id)) {
                    acc.remove.push(id);
                }
                return acc;
            },
            { add: [] as string[], remove: [] as string[] }
        )

        const [dbPermissions, dbDeletePermissions] = await Promise.all([
            permissionChanges.add.length > 0
                ? rolePermissionService.find(
                    { _id: { $in: permissionChanges.add } },
                    { session, logger, languageCode },
                    undefined,
                    "_id"
                )
                : Promise.resolve([]),
            permissionChanges.remove.length > 0
                ? rolePermissionService.find(
                    { _id: { $in: permissionChanges.remove } },
                    { session, logger, languageCode },
                    undefined,
                    "_id"
                )
                : Promise.resolve([])
        ]);

        const dbPermissionIds = dbPermissions.map((permission) => permission._id);
        const dbDeletePermissionIds = new Set(dbDeletePermissions.map((permission) => permission._id.toString()));

        const currentPermissionIds = companyRole.permissions.map((p) => p._id);
        companyRole.permissions = [
            ...currentPermissionIds.filter((pid) => !dbDeletePermissionIds.has(pid.toString())),
            ...dbPermissionIds
        ];
    }

    companyRole.$locals = companyRole.$locals || {};
    companyRole.$locals.auditUserId = new ObjectId(actionUserCtx.userId);
    await companyRole.save({session});

    logger.finish(`Finished updating company role!`);

    return {
        message: "Company role successfully updated"
    };
}

router.delete(
    "",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 60 }),
    validateFormZod(validateDeleteForm),
    transactionHandler(),
    asyncHandler(deleteCompanyRole)
);
type DeleteCompanyRoleType = TransactionRequiredParams & AuthenticatedMWType & DeleteForm;

async function deleteCompanyRole(params: DeleteCompanyRoleType): Promise<DeleteResponse> {
    const { languageCode, company, logger, session, _id, actionUserCtx } = params;

    logger.start(`Trying to delete company role...`);
    SchemaGuard.checkModelPermission(Role, "delete", actionUserCtx);

    const companyRole = await roleService.findOneOrThrow(
        {
            _id: new ObjectId(_id),
            company: new ObjectId(company._id),
            canDelete: true
        },
        { session, logger, languageCode }
    );

    // Remove role from all users' embedded CompanyRole entries
    await userService.updateMany(
        { "roles.roles": companyRole._id },
        { $pull: { "roles.$[].roles": companyRole._id } },
        { session, logger, languageCode }
    );

    const doc = await roleService.deleteByIdOrThrow(companyRole._id, {
        session,
        logger,
        languageCode,
        auditUserId: actionUserCtx.userId
    });

    let response: DeleteResponse = {
        message: "Company role successfully deleted"
    };

    try {
        const sanitizedDelete = SchemaGuard.sanitizeFields(Role, DeletedDataReadFields, "read", actionUserCtx, languageCode);
        const populate = SchemaGuard.generatePopulate(sanitizedDelete, Role.schema);
        const deletedRole = await roleService.findById(doc._id, {
            session,
            logger,
            languageCode,
            withDeleted: true
        }, populate.populate, populate.select);
        if (deletedRole) {
            response = {
                ...response,
                deletedAt: sanitizedDelete.deletedAt ? (deletedRole as any).deletedAt : undefined,
                deletedBy: sanitizedDelete.deletedBy && (deletedRole as any).deletedBy ? {
                    _id: (deletedRole as any).deletedBy?._id?.toString() ?? undefined,
                    name: (deletedRole as any).deletedBy?.name ?? undefined,
                    surname: (deletedRole as any).deletedBy?.surname ?? undefined
                } : undefined
            };
        }
    } catch {}

    logger.finish(`Finished deleting company role!`);

    return response;
}

router.patch(
    "/restore",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 60 }),
    validateFormZod(validateRestoreForm),
    transactionHandler(),
    asyncHandler(restoreCompanyRole)
);
type RestoreCompanyRoleType = TransactionRequiredParams & AuthenticatedMWType & RestoreForm;

async function restoreCompanyRole(params: RestoreCompanyRoleType): Promise<RestoreResponse> {
    const { logger, session, _id, actionUserCtx, company, languageCode } = params;

    logger.start(`Trying to restore company role...`);
    SchemaGuard.checkModelPermission(Role, "restore", actionUserCtx);

    await roleService.restoreOneOrThrow(
        { _id: new ObjectId(_id), company: company._id },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    logger.finish(`Finished restoring company role!`);

    return {
        message: "Company role successfully restored"
    };
}

router.post(
    "/permissions",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 60 }),
    validateFormZod(getPermissionsFormSchema),
    schemaSanitizer({ model: "roles", requiredModes: ["read"] }),
    asyncHandler(getPermissions)
);
type GetPermissionsType = AuthenticatedMWType & SchemaSanitizerMWType;

async function getPermissions(params: GetPermissionsType & PermissionsFormType): Promise<PermissionDto> {
    const { logger, languageCode, offset, limit } = params;

    logger.start("Serving permissions...");

    const opts = { logger, languageCode };

    const [permissions, total] = await Promise.all([
        rolePermissionService.find({}, opts, undefined, "_id group tag", undefined, limit, offset),
        rolePermissionService.count({}, opts)
    ]);

    const grouped = permissions.reduce((acc, perm) => {
        if (!acc[perm.group]) acc[perm.group] = { self: [], others: [] };
        if (perm.tag.includes(":self:")) acc[perm.group].self.push(perm);
        if (perm.tag.includes(":others:")) acc[perm.group].others.push(perm);
        acc[perm.group].self.push(perm)
        return acc;
    }, {} as Record<string, { self: any[]; others: any[] }>);
    const data = Object.fromEntries(
        Object.entries(grouped).sort(([, a], [, b]) => (b.self.length + b.others.length) - (a.self.length + a.others.length))
    );

    logger.finish("Finished serving permissions!");
    return { data, total };
}

export { router };

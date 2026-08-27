import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {rolePermissionService} from "@coreModule/database/schemas/rolePermission/rolePermission.service";
import {roleService} from "@coreModule/database/schemas/role/role.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {rolesToDTO, roleToDTO} from "@coreModule/utilities/mappers/role/roleMapper.dto";
import {rolesToSelect} from "@coreModule/utilities/mappers/role/roleMapper.select";
import {PermissionsFormType} from "armonia/src/modules/core/api/company/private/roles/permissions.form.type";
import {getPermissionsFormSchema} from "armonia/src/modules/core/api/company/private/roles/permissions.form.validator";
import Role, {type IRole} from "@coreModule/database/schemas/role/role";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {schemaSanitizer, SchemaSanitizerMWType} from "@coreModule/utilities/middlewares/schemaSanitizerMW";
import {PermissionDto} from "armonia/src/modules/core/api/company/private/roles/permission.dto";
import {createCrudRouter} from "@coreModule/api/crudRouterFactory";
import {createRoleFormSchema} from "armonia/src/modules/core/api/company/private/roles/createRole.form.validator";
import {editRoleFormSchema} from "armonia/src/modules/core/api/company/private/roles/editRole.form.validator";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import type {ObjectId} from "mongodb";

export const basePath = "/api/company/roles";

function permissionRefId(permission: unknown): string {
    if (permission && typeof permission === "object" && "_id" in permission) {
        return String((permission as {_id: ObjectId})._id);
    }
    return String(permission);
}

async function catalogPermissions(params: {logger: AuthenticatedMWType["logger"]; languageCode: string}) {
    return rolePermissionService.find(
        {},
        {logger: params.logger, languageCode: params.languageCode},
        undefined,
        "_id group tag",
    );
}

export const {router} = createCrudRouter({
    collectionName: "roles",
    model: Role,
    service: roleService,
    createSchema: createRoleFormSchema,
    editSchema: editRoleFormSchema,
    toDTO: (doc) => roleToDTO(doc, []),
    toDTOArray: (docs) => rolesToDTO(docs, []),
    toSelect: rolesToSelect,
    entityName: "Company role",
    defaultSort: {name: 1},
    extraDocumentSelect: "canDelete canEdit",
    rateLimits: {read: 60, write: 60, delete: 60},
    buildCreateData: async (params) => {
        const {permissions, name, description, company, languageCode, logger, session} = params;
        const enabledIds = Object.keys(permissions).filter((permissionId) => permissions[permissionId]);
        const foundPermissions = await rolePermissionService.find(
            {_id: {$in: enabledIds}},
            {session, logger, languageCode},
            undefined,
            "_id",
        );
        return {
            isAdmin: false,
            slug: company.name.toLowerCase().replace(/ /g, "_") + ":" + name.toLowerCase().replace(/ /g, "_"),
            name,
            ...(description ? {description} : {}),
            permissions: foundPermissions.map((permission) => permission._id),
        };
    },
    buildUpdateData: async (params, writeFields) => {
        const existing = params.existing as IRole;
        if (!existing.canEdit) {
            throw apiValidationException("userRole_not_found", null, null, params.languageCode);
        }

        const {permissions, name, description, languageCode, logger, session} = params;
        const update: Record<string, unknown> = {};

        if (writeFields.name && name !== undefined) {
            update.name = name;
        }
        if (writeFields.description && typeof description === "string") {
            update.description = description;
        }
        if (writeFields.permissions && permissions) {
            const alreadySavedPermissions = (existing.permissions ?? []).map(permissionRefId);
            const permissionChanges = Object.entries(permissions as Record<string, boolean>).reduce(
                (acc, [id, enabled]) => {
                    if (enabled && !alreadySavedPermissions.includes(id)) {
                        acc.add.push(id);
                    } else if (!enabled && alreadySavedPermissions.includes(id)) {
                        acc.remove.push(id);
                    }
                    return acc;
                },
                {add: [] as string[], remove: [] as string[]},
            );

            const [dbPermissions, dbDeletePermissions] = await Promise.all([
                permissionChanges.add.length > 0
                    ? rolePermissionService.find(
                        {_id: {$in: permissionChanges.add}},
                        {session, logger, languageCode},
                        undefined,
                        "_id",
                    )
                    : Promise.resolve([]),
                permissionChanges.remove.length > 0
                    ? rolePermissionService.find(
                        {_id: {$in: permissionChanges.remove}},
                        {session, logger, languageCode},
                        undefined,
                        "_id",
                    )
                    : Promise.resolve([]),
            ]);

            const dbPermissionIds = dbPermissions.map((permission) => permission._id);
            const dbDeletePermissionIds = new Set(dbDeletePermissions.map((permission) => permission._id.toString()));
            const currentPermissionIds = (existing.permissions ?? []).map((permission) =>
                permission && typeof permission === "object" && "_id" in permission
                    ? (permission as {_id: ObjectId})._id
                    : permission,
            );

            update.permissions = [
                ...currentPermissionIds.filter((pid) => !dbDeletePermissionIds.has(String(pid))),
                ...dbPermissionIds,
            ];
        }

        return update;
    },
    beforeDelete: async (params, doc) => {
        if (!doc.canDelete) {
            throw apiValidationException("userRole_not_found", null, null, params.languageCode);
        }
    },
    afterDelete: async (params, doc) => {
        await userService.updateMany(
            {"roles.roles": doc._id},
            {$pull: {"roles.$[].roles": doc._id}},
            {session: params.session, logger: params.logger, languageCode: params.languageCode},
        );
    },
    enrichList: async (docs, params) => rolesToDTO(docs, await catalogPermissions({logger: params.logger, languageCode: params.languageCode})),
    enrichSingle: async (doc, params) => roleToDTO(doc, await catalogPermissions({logger: params.logger, languageCode: params.languageCode})),
    enrichUpdate: async (doc, params) => roleToDTO(doc, await catalogPermissions({logger: params.logger, languageCode: params.languageCode})),
});

router.post(
    "/permissions",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(getPermissionsFormSchema),
    schemaSanitizer({model: "roles", requiredModes: ["read"]}),
    asyncHandler(getPermissions),
);
type GetPermissionsType = AuthenticatedMWType & SchemaSanitizerMWType;

async function getPermissions(params: GetPermissionsType & PermissionsFormType): Promise<PermissionDto> {
    const {logger, languageCode} = params;

    logger.start("Serving permissions...");

    const opts = {logger, languageCode};

    // Catalog endpoint: grouping by model is wrong if docs are paginated mid-group.
    const [permissions, total] = await Promise.all([
        rolePermissionService.find({}, opts, undefined, "_id group tag"),
        rolePermissionService.count({}, opts),
    ]);

    const grouped = permissions.reduce((acc, perm) => {
        if (!acc[perm.group]) acc[perm.group] = {self: [], others: []};
        const entry = {_id: perm._id, group: perm.group, tag: perm.tag};
        if (perm.tag.includes(":others:")) acc[perm.group].others.push(entry);
        else acc[perm.group].self.push(entry);
        return acc;
    }, {} as Record<string, {self: any[]; others: any[]}>);
    const data = Object.fromEntries(
        Object.entries(grouped).sort(([, a], [, b]) => (b.self.length + b.others.length) - (a.self.length + a.others.length)),
    );

    logger.finish("Finished serving permissions!");
    return {data, total};
}

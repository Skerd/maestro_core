import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import mongoose, {FieldPermissions, ModelPermissions} from "mongoose";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import RolePermission from "@coreModule/database/schemas/rolePermission/rolePermission";
import Role from "@coreModule/database/schemas/role/role";

export async function createRolePermissions(parentLogger?: serverLogger) {
    const logger = getLogger("mongoDbInitialization-createSchemaPermissions", parentLogger);
    logger.start("Creating schema-derived permissions...");

    let permissions: Record<string, FieldPermissions>[] = [];
    let modelPermissions: Record<string, ModelPermissions>[] = [];

    const modelNames = mongoose.modelNames();
    for (const modelName of modelNames) {

        const model = mongoose.model(modelName);

        let normalizedPermissions = normalizeSchemaPermissions(model);
        if( !!normalizedPermissions ){
            permissions.push(normalizedPermissions.permissions);
            modelPermissions.push(normalizedPermissions.modelPermissions);
        }
    }

    let potentialPermissions: {
        name: string,
        group: string,
        tag: string,
        alwaysActive: boolean
    }[] = [];
    let allTags: string[] = [];

    for (const permissionObj of permissions) {
        for (let [fieldName, fieldPermissions] of Object.entries(permissionObj)) {
            for (const scope of ["self", "others"]) {
                if( !fieldPermissions[scope] ) continue;
                for (const action of ["read", "write"]) {
                    const tag = fieldPermissions[scope][action];
                    if( tag === "no-permission" ) continue;

                    const groupKey = tag.substring(0, tag.indexOf("["));
                    const schemaName = groupKey.charAt(0).toUpperCase() + groupKey.slice(1);
                    let actionName = action.charAt(0).toUpperCase() + action.slice(1);

                    if( fieldName.includes("_") ){
                        let split = fieldName.split("_");
                        fieldName = split.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
                    }
                    const alwaysActive = action === "read"
                        ? fieldPermissions[scope].publicRead === true
                        : fieldPermissions[scope].publicWrite === true;

                    if( !allTags.includes(tag) ){
                        potentialPermissions.push({
                            name: `${actionName} ${fieldName}`,
                            tag,
                            group: schemaName,
                            alwaysActive
                        });
                        allTags.push(tag);
                    }
                }
            }
        }
    }

    for (const permissionObj of modelPermissions) {
        for (let [fieldName, fieldPermissions] of Object.entries(permissionObj)) {
            for (const scope of ["self", "others"]) {
                if( !fieldPermissions[scope] ) continue;
                for (const action of ["create", "delete", "restore"]) {
                    const tag = fieldPermissions[scope][action];
                    if( tag === "no-permission" ) continue;
                    const groupKey = tag.substring(0, tag.indexOf("["));
                    const schemaName = groupKey.charAt(0).toUpperCase() + groupKey.slice(1);
                    let actionName = action.charAt(0).toUpperCase() + action.slice(1);

                    if( !allTags.includes(tag) ){
                        potentialPermissions.push({
                            name: `${actionName} ${schemaName}`,
                            tag,
                            group: schemaName,
                            alwaysActive: false
                        });
                        allTags.push(tag);
                    }
                }
            }
        }
    }

    // safety check, remove duplicates
    allTags = [...new Set(allTags)];

    let alreadyFoundPermissions = await RolePermission.find({ tag: { $in: allTags } }).select("tag");
    let alreadyFoundPermissionTags = alreadyFoundPermissions.map((permission) => permission.tag);

    potentialPermissions = potentialPermissions.filter((permissions) => permissions.tag).filter((permission) => !alreadyFoundPermissionTags.includes(permission.tag));

    const newRolePermissions = potentialPermissions.map((permission) => new RolePermission(permission));
    if( newRolePermissions.length > 0 ){
        await RolePermission.bulkSave(newRolePermissions);

        const adminRoleUpdateResult = await Role.updateMany(
            { isAdmin: true },
            {
                $addToSet: {
                    permissions: {
                        $each: newRolePermissions.map((permission) => permission._id)
                    }
                }
            }
        );
        logger.debug(`Added new permissions to admin roles=${adminRoleUpdateResult.modifiedCount}`);
    }

    logger.debug(`Created=${potentialPermissions.length}, Already Present=${alreadyFoundPermissionTags.length}`);
    logger.finish(`Finished creating schema-derived permissions`);

}

import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import mongoose, {FieldPermissions, ModelPermissions} from "mongoose";
import {normalizeSchemaPermissions} from "@coreModule/database/utilities";
import RolePermission from "@coreModule/database/schemas/rolePermission/rolePermission";
import Role from "@coreModule/database/schemas/role/role";
import {getModelModule} from "@coreModule/utilities/modules/modelModules";
import {actionPermissionEntries} from "@coreModule/utilities/security/actionPermissions";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {
    findSensitiveSnippetFields,
    sensitivePaths,
    sensitivityOfPath,
    type Sensitivity,
} from "@coreModule/utilities/security/sensitiveFields";

export async function createRolePermissions(parentLogger?: serverLogger) {
    const logger = getLogger("mongoDbInitialization-createSchemaPermissions", parentLogger);
    logger.start("Creating schema-derived permissions...");

    let permissions: Record<string, FieldPermissions>[] = [];
    let modelPermissions: Record<string, ModelPermissions>[] = [];
    // Owning module of the model at the same index in `permissions` / `modelPermissions`.
    const permissionModules: string[] = [];
    // Sensitive field paths (SEC-06) of the model at the same index.
    const permissionSensitivePaths: Map<string, Sensitivity>[] = [];

    const modelNames = mongoose.modelNames();
    for (const modelName of modelNames) {

        const model = mongoose.model(modelName);

        let normalizedPermissions = normalizeSchemaPermissions(model);
        if( !!normalizedPermissions ){
            permissions.push(normalizedPermissions.permissions);
            modelPermissions.push(normalizedPermissions.modelPermissions);
            permissionModules.push(getModelModule(modelName));
            permissionSensitivePaths.push(sensitivePaths(model.schema));
        }
    }

    // SEC-06: a snippet travels into lists, other modules and notifications, so it never carries sensitive data.
    const snippetLeaks = findSensitiveSnippetFields();
    if (snippetLeaks.length > 0) {
        throw new Error(`Snippets expose sensitive fields (SEC-06): ${snippetLeaks.join("; ")}`);
    }

    let potentialPermissions: {
        name: string,
        group: string,
        tag: string,
        alwaysActive: boolean,
        module: string,
        sensitivity?: Sensitivity
    }[] = [];
    let allTags: string[] = [];
    const tagsByModule = new Map<string, string[]>();
    const recordTagModule = (tag: string, moduleName: string) => {
        tagsByModule.set(moduleName, [...(tagsByModule.get(moduleName) ?? []), tag]);
    };
    const tagsBySensitivity = new Map<Sensitivity, string[]>();

    for (const [index, permissionObj] of permissions.entries()) {
        const moduleName = permissionModules[index];
        for (let [fieldName, fieldPermissions] of Object.entries(permissionObj)) {
            // Read before `fieldName` is turned into a display name below.
            const sensitivity = sensitivityOfPath(fieldName, permissionSensitivePaths[index]);
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
                            alwaysActive,
                            module: moduleName,
                            ...(sensitivity ? {sensitivity} : {})
                        });
                        allTags.push(tag);
                        recordTagModule(tag, moduleName);
                        if (sensitivity) tagsBySensitivity.set(sensitivity, [...(tagsBySensitivity.get(sensitivity) ?? []), tag]);
                    }
                }
            }
        }
    }

    for (const [index, permissionObj] of modelPermissions.entries()) {
        const moduleName = permissionModules[index];
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
                            alwaysActive: false,
                            module: moduleName
                        });
                        allTags.push(tag);
                        recordTagModule(tag, moduleName);
                    }
                }
            }
        }
    }

    // Each mounted @action is a permission of its model (D14), in the model's group so default roles that
    // own the model get its actions. Registered by `mountActions`, which runs before this sync.
    for (const entry of actionPermissionEntries()) {
        if (allTags.includes(entry.tag)) continue;
        potentialPermissions.push(entry);
        allTags.push(entry.tag);
        recordTagModule(entry.tag, entry.module);
    }

    // safety check, remove duplicates
    allTags = [...new Set(allTags)];

    let alreadyFoundPermissions = await RolePermission.find({ tag: { $in: allTags } }).select("tag");
    let alreadyFoundPermissionTags = alreadyFoundPermissions.map((permission) => permission.tag);

    potentialPermissions = potentialPermissions.filter((permissions) => permissions.tag).filter((permission) => !alreadyFoundPermissionTags.includes(permission.tag));

    const newRolePermissions = potentialPermissions.map((permission) => new RolePermission(permission));
    if( newRolePermissions.length > 0 ){
        await RolePermission.bulkSave(newRolePermissions);

        // Every company's admin roles get the new permissions (D16: a deliberate cross-company write).
        const adminRoleUpdateResult = await asCrossTenant("new permissions go to every company's admin roles", () => Role.updateMany(
            { isAdmin: true },
            {
                $addToSet: {
                    permissions: {
                        $each: newRolePermissions.map((permission) => permission._id)
                    }
                }
            }
        ));
        logger.debug(`Added new permissions to admin roles=${adminRoleUpdateResult.modifiedCount}`);
    }

    // Existing rows (including ones written before `module` existed) follow their model's module.
    for (const [moduleName, tags] of tagsByModule) {
        await RolePermission.updateMany({tag: {$in: tags}, module: {$ne: moduleName}}, {$set: {module: moduleName}});
    }

    // Existing rows follow their field's current sensitivity, both ways.
    const sensitiveTags = [...tagsBySensitivity.values()].flat();
    for (const [sensitivity, tags] of tagsBySensitivity) {
        await RolePermission.updateMany({tag: {$in: tags}, sensitivity: {$ne: sensitivity}}, {$set: {sensitivity}});
    }
    await RolePermission.updateMany({tag: {$nin: sensitiveTags}, sensitivity: {$in: ["health", "identity", "payment"]}}, {$unset: {sensitivity: 1}});

    logger.debug(`Created=${potentialPermissions.length}, Already Present=${alreadyFoundPermissionTags.length}`);
    logger.finish(`Finished creating schema-derived permissions`);

}

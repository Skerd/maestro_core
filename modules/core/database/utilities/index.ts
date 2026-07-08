import {existsSync, mkdirSync, writeFileSync} from "fs";
import nodePath from "path";
import {AccessMode, FieldPermissions, Model, ModelPermissionAction, ModelPermissionRule, ModelPermissions, PermissionAction, PermissionRule, Schema, SchemaType, SchemaTypes} from "mongoose";
import {isPlainObject} from "@coreModule/utilities/helpers";

type NormalizedPermissions = {self: PermissionRule | ModelPermissionRule, others: PermissionRule | ModelPermissionRule};

type PermissionScope = "self" | "others";
const PERMISSION_SCOPES: PermissionScope[] = ["self", "others"];
const PERMISSION_ACTIONS: PermissionAction[] = ["read", "write"];
const MODEL_PERMISSION_ACTIONS: ModelPermissionAction[] = ["create", "delete", "restore"];
const PERMISSION_ACTION_PREFIX = /^(read|write|create|delete|restore):/;

const schemaSnapshotDirectories = new WeakMap<Schema, string>();

function resolveSnapshotDirectoryFromStack(): string | null {
    const stack = new Error().stack ?? "";
    for (const line of stack.split("\n")) {
        const match = line.match(/modules\/([^/]+)\/database\/schemas\/(?:([^/]+)\/)?([^/]+)\.(?:tsx?|jsx?)/);
        if (!match) {
            continue;
        }
        const entityFolder = match[2] ?? match[3].replace(/\.(?:tsx?|jsx?)$/, "");
        return `${match[1]}/${entityFolder}`;
    }
    return null;
}

function resolveSnapshotDirectory(schema: Schema, permissionKey: string): string {
    const cached = schemaSnapshotDirectories.get(schema);
    if (cached) {
        return cached;
    }

    const fromStack = resolveSnapshotDirectoryFromStack();
    if (fromStack) {
        schemaSnapshotDirectories.set(schema, fromStack);
        return fromStack;
    }

    return permissionKey;
}

function extractActionPayload(tag: string): string | null {
    let current = tag;
    for (let depth = 0; depth < 10; depth++) {
        const match = current.match(/^(\w+)\[(.+)\]$/);
        if (!match) {
            return null;
        }
        const inner = match[2];
        if (PERMISSION_ACTION_PREFIX.test(inner)) {
            return inner;
        }
        current = inner;
    }
    return null;
}

function normalizePermissionTag(permissionKey: string, normalizedPath: string, tag: string | undefined, defaultAction: PermissionAction | ModelPermissionAction, scope: string, accessMode: AccessMode): string | undefined {

    let accessModeScope = accessMode === "strict" ? `${scope}:` : "";

    if (!tag || !tag.trim()) {
        return `${permissionKey}[${defaultAction}:${accessModeScope}${normalizedPath}]`;
    }
    if (tag === "no-permission") {
        return tag;
    }

    const base = tag.trim().split(/\s+/, 1)[0];
    if (base.startsWith(`${permissionKey}[`)) {
        const payload = extractActionPayload(base);
        if (payload) {
            return `${permissionKey}[${payload}]`;
        }
    }

    const payload = extractActionPayload(base);
    if (payload) {
        return `${permissionKey}[${payload}]`;
    }

    const parts = base.split(":");
    const action = parts[0];
    const field = parts.length > 2 ? parts.slice(2).join("_") : parts.slice(1).join("_");

    return `${permissionKey}[${action}:${accessModeScope}${field || normalizedPath}]`;
}

function normalizePermissions(permissionKey: string, pathName: string, permissions: NormalizedPermissions, permission_actions: PermissionAction[] | ModelPermissionAction[], accessMode: AccessMode ): NormalizedPermissions {

    const isFieldPermissions = permission_actions.length === PERMISSION_ACTIONS.length && permission_actions.every(action => PERMISSION_ACTIONS.includes(action as PermissionAction));
    const isModelPermissions = permission_actions.length === MODEL_PERMISSION_ACTIONS.length && permission_actions.every(action => MODEL_PERMISSION_ACTIONS.includes(action as ModelPermissionAction));

    if( isFieldPermissions ){
        permissions = {
            self: {
                publicRead: (permissions?.self as PermissionRule)?.publicRead ?? false,
                publicWrite: (permissions?.self as PermissionRule)?.publicWrite ?? false,
                read: (permissions?.self as PermissionRule)?.read ?? "",
                write: (permissions?.self as PermissionRule)?.write ?? ""
            },
            others: {
                publicRead: (permissions?.others as PermissionRule)?.publicRead ?? false,
                publicWrite: (permissions?.others as PermissionRule)?.publicWrite ?? false,
                read: (permissions?.others as PermissionRule)?.read ?? "",
                write: (permissions?.others as PermissionRule)?.write ?? ""
            }
        };
    }
    else if( isModelPermissions ) {
        permissions = {
            self: {
                publicCreate: (permissions?.self as ModelPermissionRule)?.publicCreate ?? false,
                publicDelete: (permissions?.self as ModelPermissionRule)?.publicDelete ?? false,
                create: (permissions?.self as ModelPermissionRule)?.create ?? "",
                delete: (permissions?.self as ModelPermissionRule)?.delete ?? "",
                restore: (permissions?.self as ModelPermissionRule)?.restore ?? "",
            },
            others: {
                publicCreate: (permissions?.others as ModelPermissionRule)?.publicCreate ?? false,
                publicDelete: (permissions?.others as ModelPermissionRule)?.publicDelete ?? false,
                create: (permissions?.others as ModelPermissionRule)?.create ?? "",
                delete: (permissions?.others as ModelPermissionRule)?.delete ?? "",
                restore: (permissions?.others as ModelPermissionRule)?.restore ?? "",
            }
        };
    }
    else{
        return null;
    }

    const normalized: NormalizedPermissions = permissions;
    
    const normalizedPath = pathName.replace(/\./g, "_").replace(/_\$_/g, "_");
    for (const scope of PERMISSION_SCOPES) {
        let scopeObj = permissions[scope];
        if (!scopeObj){
            continue;
        }
        for (const action of permission_actions) {
            normalized[scope][action] = normalizePermissionTag(
                permissionKey,
                normalizedPath,
                scopeObj[action],
                action,
                scope,
                accessMode
            );
        }
    }
    if( accessMode === "loose" ){
        delete normalized["others"];
    }
    return normalized;

}

function normalizeNodePermissions(permissionKey: string, path: string, node: any, snapshot: Record<string, any>, accessMode: AccessMode): void {
    const permissions = normalizePermissions(permissionKey, path, node.permissions, PERMISSION_ACTIONS, accessMode);
    node.permissions = permissions;
    snapshot[path] = permissions;
}

function normalizeSchemaObj(permissionKey: string, schemaObj: any, pathPrefix: string = "", snapshot: Record<string, any>, accessMode: AccessMode): void {
    for (const [key, rawValue] of Object.entries(schemaObj)) {

        const path = pathPrefix ? `${pathPrefix}.${key}` : key;

        const node = Array.isArray(rawValue) ? rawValue[0] : rawValue;
        if (!isPlainObject(node)) continue;

        if (node.type) {
            normalizeNodePermissions(permissionKey, path, node, snapshot, accessMode);
        }

        const nestedType = node.type;
        if (isPlainObject(nestedType) && !(nestedType as any).instanceOf) {
            normalizeSchemaObj(permissionKey, nestedType, path, snapshot, accessMode);
        }
    }
}

function walkSchema(schema: Schema, visitor: (fieldPath: string, schemaType: SchemaType) => void, prefix = "") {
    schema.eachPath((fieldPath, schemaType) => {
        const fullPath = prefix ? `${prefix}.${fieldPath}` : fieldPath;
        visitor(fullPath, schemaType);
        if (schemaType instanceof SchemaTypes.Array && schemaType.schema instanceof Schema) {
            walkSchema(schemaType.schema, visitor, `${fullPath}.$`);
        }
        if (schemaType instanceof SchemaTypes.Subdocument && schemaType.schema instanceof Schema) {
            walkSchema(schemaType.schema, visitor, fullPath);
        }
    });
}

export function normalizeSchemaPermissions(model: Model<any>): {permissions: Record<string, FieldPermissions>, modelPermissions: Record<string, ModelPermissions>} {
    const schema = model.schema;
    const permissionKey = model.collection.name;
    const snapshot: Record<string, any> = {};

    const accessMode = (schema as any).options?.accessMode ?? "strict";

    // in here we define model permissions
    const permissions = normalizePermissions(permissionKey, permissionKey, (schema as any).options.permissions, MODEL_PERMISSION_ACTIONS, accessMode);
    (schema as any).options.permissions = permissions;
    (schema as any).options.accessMode = accessMode;
    const modelPermissionsSnapshot = {
        permissions: permissions as ModelPermissions,
        accessMode
    }

    // in here we define field permissions
    if(schema.obj) {
        normalizeSchemaObj(permissionKey, schema.obj, "", snapshot, accessMode);
    }

    walkSchema(schema, (pathName, schemaType) => {
        schemaType.options.permissions = normalizePermissions(
            permissionKey,
            pathName,
            schemaType.options?.permissions,
            PERMISSION_ACTIONS,
            accessMode
        );
        if( !(pathName.includes("_id") || pathName.includes("__v")) ){
            snapshot[pathName] = schemaType.options.permissions;
        }
    });

    let writeSchemaSnapshot = {
        "permissions": snapshot,
        "modelPermissions": {[permissionKey]: modelPermissionsSnapshot.permissions}
    }

    try {
        const snapshotDirectory = resolveSnapshotDirectory(schema, permissionKey);
        const dir = nodePath.join(__dirname, "../../../../_temp/normalizationSnapshots", snapshotDirectory);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(
            nodePath.join(dir, `${permissionKey}.json`),
            JSON.stringify(writeSchemaSnapshot, null, 2),
            "utf-8"
        );
    }
    catch (e) {
        console.error(`Failed to write normalization snapshot for ${permissionKey}:`, (e as any)?.message);
    }

    return writeSchemaSnapshot
}

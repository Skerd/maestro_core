import {type Model, Schema, SchemaTypes, type Types} from "mongoose";
import {COLUMN_TYPE} from "armonia/src/modules/core/database/filter/typeOperators";
import {
    REQUEST_DECISION_NOTES_MAX,
    REQUEST_STATUS_VALUES,
    type RequestStatus,
} from "armonia/src/modules/core/types/shared.types";
import type {IUser} from "@coreModule/database/schemas/user/user";
import {SimpleBlankUserSnippet} from "@coreModule/database/schemas/user/user.snippets";

/** Fields added by requestablePlugin. */
export interface IRequestablePluginFields {
    requestStatus?: RequestStatus;
    requestedAt?: Date;
    requestedBy?: IUser | Types.ObjectId;
    requestedByCompany?: Types.ObjectId;
    requestedByCompanyName?: string;
    decidedAt?: Date;
    decidedBy?: IUser | Types.ObjectId;
    decisionNotes?: string;
}

/**
 * The request record: shown only to the company that requested the entry and to the platform (`platformListRouteOptions`
 * strips it for everyone else). None of it is filterable or sortable, so a filter cannot reveal it either; only
 * `requestStatus` is, and every other company sees approved rows alone.
 */
export const REQUEST_RECORD_FIELDS = [
    "requestedAt", "requestedBy", "requestedByCompany", "requestedByCompanyName", "decidedAt", "decidedBy", "decisionNotes",
] as const;

/** Statuses whose rows no record may use: still waiting, or turned down / taken back (those rows are also deleted). */
export const UNUSABLE_REQUEST_STATUSES: RequestStatus[] = ["requested", "rejected", "withdrawn"];

// Written only by the server; read like the plugin fields of lifeCyclePlugin and softDeletePlugin, through each
// field's read permission (new permissions reach every company's admin roles on boot, `createRolePermissions`).
const SERVER_MANAGED = {
    self: {
        write: "no-permission"
    },
    others: {
        write: "no-permission"
    }
} as const;

/**
 * Makes a platform list requestable (D160): a company other than the platform that misses an entry creates it with the
 * list's own create form, and the entry waits as `requested`, seen only by that company and the platform and offered by
 * no select, until the platform approves it (`requestableActions`). A rejected or withdrawn entry keeps that status, who
 * decided and why, and is deleted. Rows the platform created, and seeded rows, are `approved` with no request fields.
 * The route side is `platformListRouteOptions`; notifications open the entry on its panel page,
 * `/tenancy/systemSettings/<collection>?open=<id>`, and name it by its `name`.
 */
export const requestablePlugin = (schema: Schema): void => {
    schema.add({
        requestStatus: {
            type: SchemaTypes.String,
            enum: [...REQUEST_STATUS_VALUES],
            default: "approved",
            permissions: SERVER_MANAGED,
            dynamicTableConfiguration: {
                filterable: true,
                sortable: true,
                enumTones: {requested: "warning", approved: "success", rejected: "danger", withdrawn: "neutral"},
            },
        },
        requestedAt: {
            type: SchemaTypes.Date,
            required: false,
            permissions: SERVER_MANAGED,
            dynamicTableConfiguration: {
                filterable: false,
                cellType: COLUMN_TYPE.DATETIME,
                visible: false
            },
        },
        requestedBy: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            required: false,
            refAllowlist: SimpleBlankUserSnippet,
            permissions: SERVER_MANAGED,
            dynamicTableConfiguration: {
                filterable: false,
                visible: false,
                refDisplayKey: ["name", "surname"]
            },
        },
        // The id tells the panel whether the session company asked; the name is what it shows.
        requestedByCompany: {
            type: SchemaTypes.ObjectId,
            required: false,
            permissions: SERVER_MANAGED,
            dynamicTableConfiguration: {
                filterable: false,
                hideColumn: true
            },
        },
        requestedByCompanyName: {
            type: SchemaTypes.String,
            required: false,
            permissions: SERVER_MANAGED,
            dynamicTableConfiguration: {
                filterable: false
            },
        },
        decidedAt: {
            type: SchemaTypes.Date,
            required: false,
            permissions: SERVER_MANAGED,
            dynamicTableConfiguration: {
                filterable: false,
                cellType: COLUMN_TYPE.DATETIME,
                visible: false
            },
        },
        decidedBy: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            required: false,
            refAllowlist: SimpleBlankUserSnippet,
            permissions: SERVER_MANAGED,
            dynamicTableConfiguration: {
                filterable: false,
                visible: false,
                refDisplayKey: ["name", "surname"]
            },
        },
        decisionNotes: {
            type: SchemaTypes.String,
            required: false,
            trim: true,
            maxlength: REQUEST_DECISION_NOTES_MAX,
            permissions: SERVER_MANAGED,
            dynamicTableConfiguration: {
                filterable: false,
                visible: false
            },
        },
    });
    schema.set("requestable", true);
};

/** Whether `model` applies requestablePlugin. */
export function isRequestable(model: Model<any>): boolean {
    return model.schema.get("requestable") === true;
}

export default requestablePlugin;

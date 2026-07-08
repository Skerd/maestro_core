import {FieldPermissions, Schema, SchemaTypes} from "mongoose";

export const ownershipPlugin = (schema: Schema, createdByUserPermissions?: FieldPermissions): void => {
    schema.add({
        createdBy: {
            type: SchemaTypes.ObjectId,
            ref: "User",
            required: false,
            index: true,
            refAllowlist: {
                keys: {
                    name: {},
                    surname: {},
                }
            },
            ...(
                createdByUserPermissions ?
                {
                    permissions: createdByUserPermissions
                }
                :
                {
                    permissions: {
                        self: {
                            write: "no-permission"
                        },
                        others: {
                            write: "no-permission"
                        }
                    }
                }
            ),
            dynamicTableConfiguration: {
                visible: false,
                refDisplayKey: ["name", "surname"]
            }
        },
        company: {
            type: Schema.Types.ObjectId,
            ref: "Company",
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
        }
    });

    // Compound index to keep tenant-scoped queries efficient
    schema.index({company: 1, _id: 1});
};

export default ownershipPlugin;

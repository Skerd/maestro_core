/**
 * UserRole Service
 *
 * CRUD service for UserRole model.
 */

import {BaseCrudService, CrudOptions} from '@coreModule/database/services/baseCrudService';
import Role, {IRole} from './role';
import {ObjectId} from "mongodb";
import {timeFunction} from "@coreModule/utilities/timing/functionTimer";
import {CompanyRole} from "armonia/src/modules/core/api/company/private/roles/role.dto";

export class RoleService extends BaseCrudService<IRole, typeof Role> {
    constructor() {
        super(Role, 'UserRole');
    }

    async findWithGroupedPermissions(
        companyId: ObjectId,
        canFetchedPrivileged: boolean,
        options: CrudOptions = {}
    ): Promise<CompanyRole[]> {
        const { logger, languageCode, session, timeOperations = true } = options;

        const operation = async () => {
            const pipeline = [
                {
                    $match: {
                        company: companyId,
                        ...( !canFetchedPrivileged && { isAdmin: false } )
                    }
                },

                // Convert permission IDs safely (if strings ever appear)
                {
                    $addFields: {
                        permissions: {
                            $map: {
                                input: "$permissions",
                                as: "p",
                                in: {
                                    $cond: [
                                        { $eq: [{ $type: "$$p" }, "objectId"] },
                                        "$$p",
                                        { $toObjectId: "$$p" }
                                    ]
                                }
                            }
                        }
                    }
                },

                // LOOKUP USING THE REAL COLLECTION NAME
                {
                    $lookup: {
                        from: "rolepermissions", // <- THIS FIXES YOUR ISSUE
                        localField: "permissions",
                        foreignField: "_id",
                        as: "permissions"
                    }
                },

                // Add active:true and keep fields consistent with your JS map
                {
                    $addFields: {
                        permissions: {
                            $map: {
                                input: "$permissions",
                                as: "p",
                                in: {
                                    _id: "$$p._id",
                                    tag: "$$p.tag",
                                    group: "$$p.group",
                                    active: true
                                }
                            }
                        }
                    }
                },

                // Group permissions by group (same as your reduce())
                {
                    $addFields: {
                        permissions: {
                            $arrayToObject: {
                                $map: {
                                    input: { $setUnion: ["$permissions.group", []] },
                                    as: "grp",
                                    in: {
                                        k: "$$grp",
                                        v: {
                                            $filter: {
                                                input: "$permissions",
                                                as: "perm",
                                                cond: { $eq: ["$$perm.group", "$$grp"] }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },

                {
                    $project: {
                        _id: 1,
                        name: 1,
                        slug: 1,
                        canDelete: 1,
                        canEdit: 1,
                        permissions: 1
                    }
                }
            ];
            return Role.aggregate(pipeline).session(session ?? null);
        }

        if (timeOperations && logger) {
            const { result } = await timeFunction(
                operation,
                `${this.modelName}.findWithGroupedPermissions`,
                { logger, logLevel: 'debug' }
            );
            return result;
        }

        return operation();
    }

}

export const roleService = new RoleService();

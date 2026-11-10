/**
 * User Service
 * 
 * CRUD service for User model with domain-specific methods.
 */

import {BaseCrudService, CrudOptions} from '@coreModule/database/services/baseCrudService';
import User, {IUser} from '@coreModule/database/schemas/user/user';
import {ObjectId} from 'mongodb';

export class UserService extends BaseCrudService<IUser, typeof User> {
    constructor() {
        super(User, 'User');
    }

    /** The notification codes the user turned off in this company (D117); `[]` when none or not a member. */
    async findMutedNotificationCodes(userId: ObjectId, companyId: ObjectId, options: CrudOptions = {}): Promise<string[]> {
        const user = await this.findOne({_id: userId, "roles.company": companyId}, options, undefined, "roles.company roles.mutedNotifications");
        const membership = user?.roles.find((entry) => entry.company?.toString() === companyId.toString());
        return membership?.mutedNotifications ?? [];
    }

    /**
     * Turns one notification code off (`muted`) or back on for the user in this company (D117). Writes the user's
     * membership entry for the company; a user who is not a member changes nothing.
     */
    async setNotificationMuted(userId: ObjectId, companyId: ObjectId, code: string, muted: boolean, options: CrudOptions = {}): Promise<void> {
        const update = muted
            ? {$addToSet: {"roles.$.mutedNotifications": code}}
            : {$pull: {"roles.$.mutedNotifications": code}};
        await this.updateOne({_id: userId, "roles.company": companyId}, update, options);
    }

    /** Which of `userIds` turned `code` off in this company (D117), as id strings. */
    async findUsersMutingNotification(userIds: ObjectId[], companyId: ObjectId, code: string, options: CrudOptions = {}): Promise<Set<string>> {
        if (userIds.length === 0) return new Set();
        const users = await this.find(
            {_id: {$in: userIds}, roles: {$elemMatch: {company: companyId, mutedNotifications: code}}},
            options,
            undefined,
            "_id",
        );
        return new Set(users.map((user) => user._id.toString()));
    }
}

export const userService = new UserService();


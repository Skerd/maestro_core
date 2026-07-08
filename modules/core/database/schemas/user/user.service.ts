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

    /**
     * Find user by email
     * 
     * @param email - User email
     * @param options - CRUD options
     * @returns User or null
     */
    async findByEmail(
        email: string,
        options: CrudOptions = {}
    ): Promise<IUser | null> {
        return await this.findOne(
            { email: email.toLowerCase().trim() },
            options
        );
    }

    /**
     * Find user by username
     * 
     * @param username - Username
     * @param options - CRUD options
     * @returns User or null
     */
    async findByUsername(
        username: string,
        options: CrudOptions = {}
    ): Promise<IUser | null> {
        return await this.findOne(
            { username: username.toLowerCase().trim() },
            options
        );
    }

    /**
     * Find active users for a company
     * 
     * @param companyId - Company ID
     * @param options - CRUD options
     * @returns Array of active users
     */
    async findActiveUsers(
        companyId: ObjectId,
        options: CrudOptions = {}
    ): Promise<IUser[]> {
        return await this.find(
            {
                companies: companyId,
                isActive: true
            },
            options
        );
    }

}

export const userService = new UserService();


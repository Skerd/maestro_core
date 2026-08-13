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
}

export const userService = new UserService();


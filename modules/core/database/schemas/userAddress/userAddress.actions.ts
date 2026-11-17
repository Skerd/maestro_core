import {ObjectId} from "mongodb";
import {action} from "@coreModule/api/actionDecorator";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {validateSingleForm} from "armonia/src/modules/core/utilities/zod/shared.validator";
import type {ActionMessage} from "armonia/src/modules/core/types/shared.types";
import UserAddressModel from "./userAddress";
import {userAddressService} from "./userAddress.service";

export class UserAddressActions {
    @action({
        auth: "private",
        rateLimit: {windowMs: 60000, max: 30},
        schema: validateSingleForm,
        transaction: true,
        // Only ever the caller's own address (the book clause below): no party check needed (D14, D163).
        selfService: true,
    })
    async setDefault(params: Record<string, any>): Promise<ActionMessage> {
        const {logger, languageCode, session, actionUserCtx, _id} = params;
        const book = await userAddressService.bookClause([actionUserCtx.userId]);
        const existing = await userAddressService.findOneOrThrow({...book, _id: new ObjectId(_id)}, {session, logger, languageCode});
        if (existing.isDefault) {
            throw apiValidationException("user_address_already_default", "", null, languageCode);
        }
        // One default per type in a person's book.
        await UserAddressModel.updateMany(
            {...book, type: existing.type, isDefault: true, _id: {$ne: existing._id}},
            {$set: {isDefault: false}},
            {session},
        );
        await userAddressService.updateByIdOrThrow(
            existing._id,
            {isDefault: true},
            {session, logger, languageCode, auditUserId: actionUserCtx.userId},
        );
        return {message: "Address set as default"};
    }
}

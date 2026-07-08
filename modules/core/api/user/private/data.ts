import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {ChangePasswordFormType} from "armonia/src/modules/core/api/user/private/data/changePassword.form.type";
import {
    ChangePasswordFormResponseType
} from "armonia/src/modules/core/api/user/private/data/changePassword.form.response.type";
import {
    UpdateUserProfileNameFormType
} from "armonia/src/modules/core/api/user/private/data/updateUserProfileName.form.type";
import {
    UserProfileNameFormResponse
} from "armonia/src/modules/core/api/user/private/data/userProfileName.form.response.type";
import {
    UpdateUserProfileSurnameFormType
} from "armonia/src/modules/core/api/user/private/data/updateUserProfileSurname.form.type";
import {
    UserProfileSurnameFormResponse
} from "armonia/src/modules/core/api/user/private/data/userProfileSurname.form.response.type";
import {
    UpdateEmailPreferenceFormType
} from "armonia/src/modules/core/api/user/private/data/updateEmailPreference.form.type";
import {
    EmailPreferencesFormResponse
} from "armonia/src/modules/core/api/user/private/data/emailPreferences.form.response.type";
import {
    UpdateUserProfileTimezoneFormType
} from "armonia/src/modules/core/api/user/private/data/updateUserProfileTimezone.form.type";
import {
    UserProfileTimezoneFormResponseType
} from "armonia/src/modules/core/api/user/private/data/userProfileTimezone.form.response.type";
import {changePasswordFormSchema} from "armonia/src/modules/core/api/user/private/data/changePassword.form.validator";
import {
    updateEmailPreferenceFormSchema
} from "armonia/src/modules/core/api/user/private/data/updateEmailPreference.form.validator";
import {
    updateUserProfileNameFormSchema
} from "armonia/src/modules/core/api/user/private/data/updateUserProfileName.form.validator";
import {
    updateUserProfileSurnameFormSchema
} from "armonia/src/modules/core/api/user/private/data/updateUserProfileSurname.form.validator";
import {
    updateUserProfileTimezoneFormSchema
} from "armonia/src/modules/core/api/user/private/data/updateUserProfileTimezone.form.validator";
import {mediaService} from "@coreModule/database/schemas/media/media.service";
import {userService} from "@coreModule/database/schemas/user/user.service";
import {
    UpdateEmailPreferenceFormResponseType
} from "armonia/src/modules/core/api/user/private/data/updateEmailPreference.form.response.type";
import {
    UpdateUserProfileNameFormResponseType
} from "armonia/src/modules/core/api/user/private/data/updateUserProfileName.form.response.type";
import {
    UpdateUserProfileSurnameFormResponse
} from "armonia/src/modules/core/api/user/private/data/updateUserProfileSurname.form.respone.type";
import {
    UpdateUserProfileTimezoneFormResponseType
} from "armonia/src/modules/core/api/user/private/data/updateUserProfileTimezone.form.response.type";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {
    PhoneNumberFormResponseType
} from "armonia/src/modules/core/api/user/private/data/phoneNumber.form.response.type";
import {
    UpdatePhoneNumberFormResponseType
} from "armonia/src/modules/core/api/user/private/data/updatePhoneNumber.form.response.type";
import {UpdatePhoneNumberFormType} from "armonia/src/modules/core/api/user/private/data/updatePhoneNumber.form.type";
import {
    updatePhoneNumberFormSchema
} from "armonia/src/modules/core/api/user/private/data/updatePhoneNumber.form.validator";
import {
    UpdateProfilePhotoFormResponseType
} from "armonia/src/modules/core/api/user/private/data/updateProfilePhoto.form.response.type";
import {MediaUploaded, mediaUploadMW} from "@coreModule/utilities/middlewares/mediaUploadMW";
import {getGridFSStorage} from "@coreModule/utilities/gridfs/gridfsStorage";
import {
    DeleteProfilePhotoFormResponseType
} from "armonia/src/modules/core/api/user/private/data/deleteProfilePhoto.form.response.type";
import {
    UpdateProfileCoverPhotoFormResponseType
} from "armonia/src/modules/core/api/user/private/data/updateProfileCoverPhoto.form.response.type";
import {
    DeleteProfileCoverPhotoFormResponseType
} from "armonia/src/modules/core/api/user/private/data/deleteProfileCoverPhoto.form.response.type";
import {Media} from "armonia/src/modules/core/types";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import User from "@coreModule/database/schemas/user/user";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {CompanyUserType} from "armonia/src/modules/core/api/company/private/users/allUsers.form.response.type";
import {userToCompanyUserDTO} from "@coreModule/utilities/mappers/user/userMapper.dto";
import {schemaSanitizer, SchemaSanitizerMWType} from "@coreModule/utilities/middlewares/schemaSanitizerMW";

/**
 * User profile data API – private endpoints for managing the authenticated user's profile.
 *
 * Mounted under the user private routes (e.g. `/user/data`). All endpoints require
 * authentication. Field-level access is enforced via SchemaGuard. Profile updates are audited.
 *
 * **Routes:**
 * - `GET ""` – Full user account info (profile, companies, roles, status, lastLogin).
 * - `GET "/username"` – Email/username and verification status.
 * - `PATCH "/username"` – Initiate email change (sends activation email to new address).
 * - `GET "/name"` – User's first name.
 * - `PATCH "/name"` – Update first name.
 * - `GET "/surname"` – User's surname.
 * - `PATCH "/surname"` – Update surname.
 * - `GET "/phoneNumber"` – User's phone number.
 * - `PATCH "/phoneNumber"` – Update phone number.
 * - `GET "/timezone"` – User's timezone preference.
 * - `PATCH "/timezone"` – Update timezone preference.
 * - `GET "/profilePhoto"` – Profile photo media metadata (or null).
 * - `PATCH "/profilePhoto"` – Update profile photo (upload; replaces existing).
 * - `DELETE "/profilePhoto"` – Delete profile photo.
 * - `GET "/coverPhoto"` – Cover photo media metadata (or null).
 * - `PATCH "/coverPhoto"` – Update cover photo (upload; replaces existing).
 * - `DELETE "/coverPhoto"` – Delete cover photo.
 * - `GET "/companies"` – User's companies with roles (filtered by action user context).
 * - `PATCH "/password"` – Change password (validates current password unless parentBypass).
 *
 * @module f_endpoints/core/user/private/data
 */

const router = Router();

/**
 * GET /api/user/data
 * 
 * Fetches comprehensive user account information including profile data, companies, and roles.
 * 
 * @route GET /api/user/data
 * @access Private
 * @returns {Promise<UserInfoFormResponseType>} Complete user profile information
 * 
 * @remarks
 * - Returns user data filtered by user's read permissions
 * - Only returns companies that both the action user and target user share
 * - Includes user status (active/inactive/invited) and login information
 * - Fields are filtered based on actionUserCtx permissions
 */
router.get(
    "",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60,}),
    schemaSanitizer({model: "users", requiredModes: ["read"]}),
    asyncHandler(GetUser)
);
/**
 * Fetches comprehensive user account information with permission-based filtering.
 * 
 * @param params - Authenticated middleware parameters
 * @returns Complete user profile data with status and login information
 */
async function GetUser(params: AuthenticatedMWType & SchemaSanitizerMWType): Promise<CompanyUserType> {
    const { logger, userInfo, actionUserInfo, actionUserCtx, languageCode, sanitizedReadFields } = params;

    logger.start(`Trying to fetch user info...`);

    const populate = SchemaGuard.generatePopulate(sanitizedReadFields, User.schema);

    const actionUserCompanies = (await actionUserInfo.getCompanies()).map((c) => c._id.toString());
    const userCompanies = (await userInfo.getCompanies()).filter((c) => actionUserCompanies.includes(c._id.toString()));

    const user = await userService.findOne(
        {
            _id: userInfo._id,
            companies: userCompanies,
            "roles.company": { $in: userCompanies }
        },
        {logger, languageCode},
        populate.populate,
        (populate.select || "") + " requests.invitation.invitedBy requests.activation.email"
    );

    const dto = userToCompanyUserDTO(user);
    if (!dto) {
        throw new Error("User data could not be mapped");
    }

    logger.finish(`Successfully fetched user info!`);

    return dto;
}

/**
 * GET /api/user/data/username
 * 
 * Fetches user's email/username and verification status.
 * 
 * @route GET /api/user/data/username
 * @access Private
 * @returns {Promise<EmailPreferencesFormResponse>} Email, verification status, and pending email change
 * 
 * @remarks
 * - Returns current username (email), verification status, and any pending email change request
 * - Respects read permissions for username and isEmailVerified fields
 */
router.get(
    "/username",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(GetUserUsername)
);
/**
 * Fetches user's email/username and verification status.
 * 
 * @param params - Authenticated middleware parameters
 * @returns Email information including verification status
 */
async function GetUserUsername(params: AuthenticatedMWType): Promise<EmailPreferencesFormResponse> {
    const { logger, userInfo, languageCode, actionUserCtx } = params;

    SchemaGuard.sanitizeFields(User, {username: {}, isEmailVerified: {}}, "read", actionUserCtx, languageCode);

    logger.start(`Serving user username...`);
    logger.finish('Finished serving user username!');

    return {
        email: userInfo.username,
        verified: userInfo.isEmailVerified,
        unverifiedEmail: userInfo.requests?.activation?.email || ""
    };
}

/**
 * PATCH /api/user/data/username
 * 
 * Initiates an email/username change by sending an activation email to the new address.
 * 
 * @route PATCH /api/user/data/username
 * @access Private
 * @requires Transaction
 * @body {UpdateEmailPreferenceFormType} - New email address
 * @returns {Promise<UpdateEmailPreferenceFormResponseType>} Success message
 * 
 * @throws {apiValidationException} If email is already in use by another user
 * 
 * @remarks
 * - Does not immediately change the username; sends activation email instead
 * - User must verify the new email before the change takes effect
 * - Validates email uniqueness before sending activation email
 * - Note: This endpoint doesn't directly update the user document, so no audit log is created here
 */
router.patch(
    "/username",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(updateEmailPreferenceFormSchema),
    transactionHandler(),
    asyncHandler(UpdateUserUsername)
);
/**
 * Initiates email change by sending activation email to new address.
 * 
 * @param params - Transaction, form, and authenticated parameters
 * @returns Success message
 */
async function UpdateUserUsername(params: TransactionRequiredParams & UpdateEmailPreferenceFormType & AuthenticatedMWType): Promise<UpdateEmailPreferenceFormResponseType> {
    const { languageCode, newEmail, logger, userInfo, session, actionUserCtx } = params;

    logger.start(`Trying to update user username...`);

    SchemaGuard.sanitizeFields(User, {username: {}}, "write", actionUserCtx, languageCode);

    const foundUser = await userService.findOne(
        {
            username: newEmail,
            _id: { $ne: userInfo._id }
        },
        { session, logger, languageCode }
    );

    if (foundUser) {
        throw apiValidationException("email_already_used", null, null, languageCode);
    }

    let thisUser =  await userService.findOne(
        {
            _id: userInfo._id
        },
        { session, logger, languageCode }
    );

    if( !!thisUser ){
        let foundRole = thisUser.roles.find((role) => role.active === "invited");
        if( !!foundRole ){
            foundRole.active = "active";
            await thisUser.save({session});
        }
    }

    await userInfo.sendActivationEmail(newEmail, languageCode, session);



    logger.finish(`Successfully updated user username!`);

    return {
        message: "Email updated!"
    };
}

/**
 * GET /api/user/data/name
 * 
 * Fetches the user's first name.
 * 
 * @route GET /api/user/data/name
 * @access Private
 * @returns {Promise<UserProfileNameFormResponse>} User's first name
 * 
 * @remarks
 * - Respects read permissions for name field
 */
router.get(
    "/name",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(GetUserName)
);
/**
 * Fetches the user's first name.
 * 
 * @param params - Authenticated middleware parameters
 * @returns User's first name
 */
async function GetUserName(params: AuthenticatedMWType): Promise<UserProfileNameFormResponse> {
    const { logger, userInfo, actionUserCtx, languageCode } = params;

    logger.start(`Serving user name...`);
    SchemaGuard.sanitizeFields(User, {name: {}}, "read", actionUserCtx, languageCode);
    logger.finish('Finished serving user name!');

    return {
        name: userInfo.name
    };
}

/**
 * PATCH /api/user/data/name
 * 
 * Updates the user's first name.
 * 
 * @route PATCH /api/user/data/name
 * @access Private
 * @requires Transaction
 * @body {UpdateUserProfileNameFormType} - New first name
 * @returns {Promise<UpdateUserProfileNameFormResponseType>} Success message
 * 
 * @remarks
 * - Requires write permission for name field
 * - Changes are audited with actor information
 */
router.patch(
    "/name",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(updateUserProfileNameFormSchema),
    transactionHandler(),
    asyncHandler(UpdateUserName)
);
/**
 * Updates the user's first name.
 * 
 * @param params - Transaction, form, and authenticated parameters
 * @returns Success message
 */
async function UpdateUserName(params: TransactionRequiredParams & UpdateUserProfileNameFormType & AuthenticatedMWType): Promise<UpdateUserProfileNameFormResponseType> {
    const { name, logger, userInfo, session, languageCode, actionUserCtx } = params;

    logger.start(`Trying to update user's name...`);
    SchemaGuard.sanitizeFields(User, {name: {}}, "write", actionUserCtx, languageCode);

    userInfo.name = name;
    userInfo.$locals = userInfo.$locals || {};
    userInfo.$locals.auditUserId = new ObjectId(actionUserCtx.userId);
    await userInfo.save({session});

    logger.finish(`Successfully updated user's name!`);

    return { message: "Name updated!" };
}

/**
 * GET /api/user/data/surname
 * 
 * Fetches the user's surname/last name.
 * 
 * @route GET /api/user/data/surname
 * @access Private
 * @returns {Promise<UserProfileSurnameFormResponse>} User's surname
 * 
 * @remarks
 * - Respects read permissions for surname field
 */
router.get(
    "/surname",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(GetUserSurname)
);
/**
 * Fetches the user's surname/last name.
 * 
 * @param params - Authenticated middleware parameters
 * @returns User's surname
 */
async function GetUserSurname(params: AuthenticatedMWType): Promise<UserProfileSurnameFormResponse> {
    const { logger, userInfo, actionUserCtx, languageCode } = params;

    logger.start(`Serving user's surname...`);
    SchemaGuard.sanitizeFields(User, {surname: {}}, "read", actionUserCtx, languageCode);
    logger.finish(`Finished serving user's surname!`);

    return {
        surname: userInfo.surname
    };
}

/**
 * PATCH /api/user/data/surname
 *
 * Updates the user's surname/last name.
 *
 * @route PATCH /api/user/data/surname
 * @access Private
 * @requires Transaction
 * @body {UpdateUserProfileSurnameFormType} - New surname
 * @returns {Promise<UpdateUserProfileSurnameFormResponse>} Success message
 *
 * @remarks
 * - Requires write permission for surname field
 * - Changes are audited with actor information
 */
router.patch(
    "/surname",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(updateUserProfileSurnameFormSchema),
    transactionHandler(),
    asyncHandler(UpdateUserSurname)
);
/**
 * Updates the user's surname/last name.
 *
 * @param params - Transaction, form, and authenticated parameters
 * @returns Success message
 */
async function UpdateUserSurname(params: TransactionRequiredParams & UpdateUserProfileSurnameFormType & AuthenticatedMWType): Promise<UpdateUserProfileSurnameFormResponse> {
    const { surname, logger, userInfo, session, actionUserCtx, languageCode } = params;

    logger.start(`Trying to update user's surname...`);
    SchemaGuard.sanitizeFields(User, {surname: {}}, "write", actionUserCtx, languageCode);

    userInfo.surname = surname;
    userInfo.$locals = userInfo.$locals || {};
    userInfo.$locals.auditUserId = new ObjectId(actionUserCtx.userId);
    await userInfo.save({session});

    logger.finish(`Successfully updated user's surname!`);

    return { message: "Surname updated!" };
}

/**
 * GET /api/user/data/phoneNumber
 * 
 * Fetches the user's phone number.
 * 
 * @route GET /api/user/data/phoneNumber
 * @access Private
 * @returns {Promise<PhoneNumberFormResponseType>} User's phone number
 * 
 * @remarks
 * - Respects read permissions for phoneNumber field
 */
router.get(
    "/phoneNumber",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(getPhoneNumber)
);
/**
 * Fetches the user's phone number.
 * 
 * @param params - Authenticated middleware parameters
 * @returns User's phone number
 */
async function getPhoneNumber(params: AuthenticatedMWType): Promise<PhoneNumberFormResponseType> {
    const { logger, userInfo, actionUserCtx, languageCode } = params;

    logger.start(`Serving user phone number...`);
    SchemaGuard.sanitizeFields(User, {phoneNumber: {}}, "read", actionUserCtx, languageCode);
    logger.finish(`Finished serving user phone number!`);

    return {
        phoneNumber: userInfo.phoneNumber
    };
}

/**
 * PATCH /api/user/data/phoneNumber
 * 
 * Updates the user's phone number.
 * 
 * @route PATCH /api/user/data/phoneNumber
 * @access Private
 * @requires Transaction
 * @body {UpdatePhoneNumberFormType} - New phone number
 * @returns {Promise<UpdatePhoneNumberFormResponseType>} Success message
 * 
 * @remarks
 * - Requires write permission for phoneNumber field
 * - Changes are audited with actor information
 */
router.patch(
    "/phoneNumber",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(updatePhoneNumberFormSchema),
    transactionHandler(),
    asyncHandler(UpdatePhoneNumber)
);
/**
 * Updates the user's phone number.
 * 
 * @param params - Transaction, form, and authenticated parameters
 * @returns Success message
 */
async function UpdatePhoneNumber(params: TransactionRequiredParams & UpdatePhoneNumberFormType & AuthenticatedMWType): Promise<UpdatePhoneNumberFormResponseType> {
    const { languageCode, phoneNumber, logger, userInfo, session, actionUserCtx } = params;

    logger.start(`Trying to update user phone number...`);
    SchemaGuard.sanitizeFields(User, {phoneNumber: {}}, "write", actionUserCtx, languageCode);

    userInfo.phoneNumber = phoneNumber;
    userInfo.$locals = userInfo.$locals || {};
    userInfo.$locals.auditUserId = new ObjectId(actionUserCtx.userId);
    await userInfo.save({session});

    logger.finish(`Successfully updated user phone number!`);

    return {
        message: "Successfully updated phone number!"
    };
}

/**
 * GET /api/user/data/timezone
 * 
 * Fetches the user's timezone preference.
 * 
 * @route GET /api/user/data/timezone
 * @access Private
 * @returns {Promise<UserProfileTimezoneFormResponseType>} User's timezone
 * 
 * @remarks
 * - Respects read permissions for timezone field
 */
router.get(
    "/timezone",
    authMW("private"),
    rateLimiter({windowMs: 6000, max: 20}),
    asyncHandler(GetUserTimezonePreferences)
);
/**
 * Fetches the user's timezone preference.
 * 
 * @param params - Authenticated middleware parameters
 * @returns User's timezone
 */
async function GetUserTimezonePreferences(params: AuthenticatedMWType): Promise<UserProfileTimezoneFormResponseType> {
    const { logger, userInfo, actionUserCtx, languageCode } = params;

    logger.start(`Serving user timezone...`);
    SchemaGuard.sanitizeFields(User, {timezone: {}}, "read", actionUserCtx, languageCode);
    logger.finish('Finished serving user timezone!');

    return {
        timezone: userInfo.timezone
    };
}

/**
 * PATCH /api/user/data/timezone
 * 
 * Updates the user's timezone preference.
 * 
 * @route PATCH /api/user/data/timezone
 * @access Private
 * @requires Transaction
 * @body {UpdateUserProfileTimezoneFormType} - New timezone
 * @returns {Promise<UpdateUserProfileTimezoneFormResponseType>} Success message
 * 
 * @remarks
 * - Requires write permission for timezone field
 * - Changes are audited with actor information
 */
router.patch(
    "/timezone",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(updateUserProfileTimezoneFormSchema),
    transactionHandler(),
    asyncHandler(UpdateUserTimezonePreferences)
);
/**
 * Updates the user's timezone preference.
 * 
 * @param params - Transaction, form, and authenticated parameters
 * @returns Success message
 */
async function UpdateUserTimezonePreferences(params: TransactionRequiredParams & UpdateUserProfileTimezoneFormType & AuthenticatedMWType): Promise<UpdateUserProfileTimezoneFormResponseType> {
    const { newTimezone, logger, userInfo, session, languageCode, actionUserCtx } = params;

    logger.start(`Trying to update user timezone...`);
    SchemaGuard.sanitizeFields(User, {timezone: {}}, "write", actionUserCtx, languageCode);

    userInfo.timezone = newTimezone;
    userInfo.$locals = userInfo.$locals || {};
    userInfo.$locals.auditUserId = new ObjectId(actionUserCtx.userId);
    await userInfo.save({session});

    logger.finish(`Successfully updated user timezone!`);

    return { message: "Timezone updated!" };
}

/**
 * GET /api/user/data/profilePhoto
 * 
 * Fetches the user's profile photo media information.
 * 
 * @route GET /api/user/data/profilePhoto
 * @access Private
 * @requires Transaction
 * @returns {Promise<Media | null>} Profile photo media data or null if no photo
 * 
 * @remarks
 * - Respects read permissions for photo field
 * - Returns null if user has no profile photo
 * - Returns media metadata including file ID and name
 */
router.get(
    "/profilePhoto",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    transactionHandler(),
    asyncHandler(getProfilePhoto)
);
/**
 * Fetches the user's profile photo media information.
 * 
 * @param params - Transaction and authenticated parameters
 * @returns Profile photo media data or null
 */
async function getProfilePhoto(params: TransactionRequiredParams & AuthenticatedMWType): Promise<Media | null> {
    const { languageCode, logger, userInfo, session, actionUserCtx } = params;

    logger.start(`Trying to get profile photo...`);
    SchemaGuard.sanitizeFields(User, {photo: {}}, "read", actionUserCtx, languageCode);

    // Check if user has a profile photo
    if (!userInfo.photo) {
        logger.finish(`No profile photo found for user`);
        return null;
    }

    // Get the media document
    const profilePhotoId = userInfo.photo instanceof ObjectId ? userInfo.photo : new ObjectId(userInfo.photo.toString());

    const media = await mediaService.findByIdOrThrow(
        profilePhotoId,
        { logger, languageCode, session }
    );

    logger.finish(`Profile photo successfully retrieved!`);

    return media ? {
        _id: media._id,
        name: media.fileName,
        size: media.fileSize,
        extension: media.extension,
        mime: media.mimeType,
        safeCheckedFlag: media.metadata?.safeCheckedFlag,
        scannedAt: media.metadata?.scannedAt,
        scannerResult: media.metadata?.scannerResult,
        resolution: {
            width: media.metadata?.resolution?.width,
            height: media.metadata?.resolution?.height
        },
        durationInSeconds: media.metadata?.durationInSeconds
    } : null;
}

/**
 * PATCH /api/user/data/profilePhoto
 * 
 * Updates the user's profile photo by uploading a new image.
 * 
 * @route PATCH /api/user/data/profilePhoto
 * @access Private
 * @requires Transaction
 * @requires MediaUpload (max 1 file, 5MB)
 * @body FormData with image file
 * @returns {Promise<UpdateProfilePhotoFormResponseType>} Success message
 * 
 * @remarks
 * - Requires write permission for photo field
 * - Replaces existing profile photo (old photo is deleted from GridFS)
 * - Changes are audited with actor information
 * - Maximum file size: 5MB
 */
router.patch(
    "/profilePhoto",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    transactionHandler(),
    mediaUploadMW({maxFiles: 1, maxFileSize: 1024 * 1024 * 5}),
    asyncHandler(profilePhotoUpdate)
);
/**
 * Updates the user's profile photo, deleting the old one if it exists.
 * 
 * @param params - Transaction, media upload, and authenticated parameters
 * @returns Success message
 */
async function profilePhotoUpdate(params: TransactionRequiredParams & MediaUploaded & AuthenticatedMWType): Promise<UpdateProfilePhotoFormResponseType> {
    const { languageCode, logger, userInfo, session, fileIds, actionUserCtx } = params;

    logger.start(`Trying to change profile photo...`);
    SchemaGuard.sanitizeFields(User, {photo: {}}, "write", actionUserCtx, languageCode);

    let profilePhoto: ObjectId = userInfo.photo?._id;
    if( !!profilePhoto ){
        let media = await mediaService.findById(profilePhoto, {logger, languageCode, session});
        const gridfs = getGridFSStorage(languageCode, 'media', logger);
        await gridfs.deleteFile(media.fileId.toString());
        await mediaService.deleteById(profilePhoto, {logger, languageCode, session, hard: true});
    }

    //@ts-ignore
    userInfo.photo = fileIds[0];
    userInfo.$locals = userInfo.$locals || {};
    userInfo.$locals.auditUserId = new ObjectId(actionUserCtx.userId);
    await userInfo.save({session});

    logger.finish(`Profile photo successfully changed!`);

    return {
        message: "Profile photo successfully changed",
        photo: fileIds[0].toString()
    };
}

/**
 * DELETE /api/user/data/profilePhoto
 * 
 * Deletes the user's profile photo.
 * 
 * @route DELETE /api/user/data/profilePhoto
 * @access Private
 * @requires Transaction
 * @returns {Promise<DeleteProfilePhotoFormResponseType>} Success message
 * 
 * @remarks
 * - Requires write permission for photo field
 * - Deletes photo from GridFS storage and removes reference from user document
 * - Changes are audited with actor information
 */
router.delete(
    "/profilePhoto",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    transactionHandler(),
    asyncHandler(profilePhotoDelete)
);
/**
 * Deletes the user's profile photo from storage and user document.
 * 
 * @param params - Transaction and authenticated parameters
 * @returns Success message
 */
async function profilePhotoDelete(params: TransactionRequiredParams & AuthenticatedMWType): Promise<DeleteProfilePhotoFormResponseType> {
    const { languageCode, logger, userInfo, session, actionUserCtx } = params;

    logger.start(`Trying to delete profile photo...`);
    SchemaGuard.sanitizeFields(User, {photo: {}}, "write", actionUserCtx, languageCode);

    let profilePhoto: ObjectId = userInfo.photo?._id;
    if( !!profilePhoto ){
        let media = await mediaService.findById(profilePhoto, {logger, languageCode, session});
        const gridfs = getGridFSStorage(languageCode, 'media', logger);
        await gridfs.deleteFile(media.fileId.toString());
        await mediaService.deleteById(profilePhoto, {logger, languageCode, session, hard: true});
    }

    userInfo.photo = null;
    userInfo.$locals = userInfo.$locals || {};
    userInfo.$locals.auditUserId = new ObjectId(actionUserCtx.userId);
    await userInfo.save({session});

    logger.finish(`Profile photo successfully deleted!`);

    return {
        message: "Profile photo successfully deleted"
    };
}

/**
 * GET /api/user/data/coverPhoto
 * 
 * Fetches the user's cover photo media information.
 * 
 * @route GET /api/user/data/coverPhoto
 * @access Private
 * @requires Transaction
 * @returns {Promise<Media | null>} Cover photo media data or null if no photo
 * 
 * @remarks
 * - Respects read permissions for cover field
 * - Returns null if user has no cover photo
 * - Returns media metadata including file ID and name
 */
router.get(
    "/coverPhoto",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    transactionHandler(),
    asyncHandler(getCoverPhoto)
);
/**
 * Fetches the user's cover photo media information.
 * 
 * @param params - Transaction and authenticated parameters
 * @returns Cover photo media data or null
 */
async function getCoverPhoto(params: TransactionRequiredParams & AuthenticatedMWType): Promise<Media | null> {
    const { languageCode, logger, userInfo, session, actionUserCtx } = params;

    logger.start(`Trying to get cover photo...`);
    SchemaGuard.sanitizeFields(User, {cover: {}}, "read", actionUserCtx, languageCode);

    // Check if user has a profile photo
    if (!userInfo.cover) {
        logger.finish(`No cover photo found for user`);
        return null;
    }

    // Get the media document
    const coverPhotoId = userInfo.cover instanceof ObjectId ? userInfo.cover : new ObjectId(userInfo.cover.toString());

    const media = await mediaService.findByIdOrThrow(
        coverPhotoId,
        { logger, languageCode, session }
    );

    logger.finish(`Cover photo successfully retrieved!`);

    return media ? {
        _id: media._id,
        name: media.fileName,
        size: media.fileSize,
        extension: media.extension,
        mime: media.mimeType,
        safeCheckedFlag: media.metadata?.safeCheckedFlag,
        scannedAt: media.metadata?.scannedAt,
        scannerResult: media.metadata?.scannerResult,
        resolution: {
            width: media.metadata?.resolution?.width,
            height: media.metadata?.resolution?.height
        },
        durationInSeconds: media.metadata?.durationInSeconds
    } : null;
}

/**
 * PATCH /api/user/data/coverPhoto
 * 
 * Updates the user's cover photo by uploading a new image.
 * 
 * @route PATCH /api/user/data/coverPhoto
 * @access Private
 * @requires Transaction
 * @requires MediaUpload (max 1 file, 5MB)
 * @body FormData with image file
 * @returns {Promise<UpdateProfileCoverPhotoFormResponseType>} Success message
 * 
 * @remarks
 * - Requires write permission for cover field
 * - Replaces existing cover photo (old photo is deleted from GridFS)
 * - Changes are audited with actor information
 * - Maximum file size: 5MB
 */
router.patch(
    "/coverPhoto",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    transactionHandler(),
    mediaUploadMW({maxFiles: 1, maxFileSize: 1024 * 1024 * 5}),
    asyncHandler(coverPhotoUpdate)
);
/**
 * Updates the user's cover photo, deleting the old one if it exists.
 * 
 * @param params - Transaction, media upload, and authenticated parameters
 * @returns Success message
 */
async function coverPhotoUpdate(params: TransactionRequiredParams & MediaUploaded & AuthenticatedMWType): Promise<UpdateProfileCoverPhotoFormResponseType> {
    const { languageCode, logger, userInfo, session, fileIds, actionUserCtx } = params;

    logger.start(`Trying to change cover photo...`);
    SchemaGuard.sanitizeFields(User, {cover: {}}, "write", actionUserCtx, languageCode);

    let coverPhoto: ObjectId = userInfo.cover?._id;
    if( !!coverPhoto ){
        let media = await mediaService.findById(coverPhoto, {logger, languageCode, session});
        const gridfs = getGridFSStorage(languageCode, 'media', logger);
        await gridfs.deleteFile(media.fileId.toString());

        await mediaService.deleteById(coverPhoto, {logger, languageCode, session, hard: true});
    }

    //@ts-ignore
    userInfo.cover = fileIds[0];
    userInfo.$locals = userInfo.$locals || {};
    userInfo.$locals.auditUserId = new ObjectId(actionUserCtx.userId);
    await userInfo.save({session});

    logger.finish(`Cover photo successfully changed!`);

    return {
        message: "Cover photo successfully changed",
        cover: fileIds[0].toString()
    };
}

/**
 * DELETE /api/user/data/coverPhoto
 * 
 * Deletes the user's cover photo.
 * 
 * @route DELETE /api/user/data/coverPhoto
 * @access Private
 * @requires Transaction
 * @returns {Promise<DeleteProfileCoverPhotoFormResponseType>} Success message
 * 
 * @remarks
 * - Requires write permission for cover field
 * - Deletes photo from GridFS storage and removes reference from user document
 * - Changes are audited with actor information
 */
router.delete(
    "/coverPhoto",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    transactionHandler(),
    asyncHandler(coverPhotoDelete)
);
/**
 * Deletes the user's cover photo from storage and user document.
 * 
 * @param params - Transaction and authenticated parameters
 * @returns Success message
 */
async function coverPhotoDelete(params: TransactionRequiredParams & AuthenticatedMWType): Promise<DeleteProfileCoverPhotoFormResponseType> {
    const { languageCode, logger, userInfo, session, actionUserCtx} = params;

    logger.start(`Trying to delete cover photo...`);
    SchemaGuard.sanitizeFields(User, {cover: {}}, "write", actionUserCtx, languageCode);

    let coverPhoto: ObjectId = userInfo.cover?._id;
    if( !!coverPhoto ){
        let media = await mediaService.findById(coverPhoto, {logger, languageCode, session});
        const gridfs = getGridFSStorage(languageCode, 'media', logger);
        await gridfs.deleteFile(media.fileId.toString());
        await mediaService.deleteById(coverPhoto, {logger, languageCode, session, hard: true});
    }

    userInfo.cover = null;
    userInfo.$locals = userInfo.$locals || {};
    userInfo.$locals.auditUserId = new ObjectId(actionUserCtx.userId);
    await userInfo.save({session});

    logger.finish(`Cover photo successfully deleted!`);

    return {
        message: "Cover photo successfully deleted"
    };
}

/**
 * PATCH /api/user/data/password
 * 
 * Changes the user's password after validating the current password.
 * 
 * @route PATCH /api/user/data/password
 * @access Private
 * @requires Transaction
 * @body {ChangePasswordFormType} - Current and new password
 * @returns {Promise<ChangePasswordFormResponseType>} Success message
 * 
 * @throws {apiValidationException} If current password is incorrect (unless parentBypass is set)
 * 
 * @remarks
 * - Requires write permission for password field
 * - Validates current password before allowing change (unless parentBypass is set)
 * - Resets unsuccessful login attempts after password change
 * - Changes are audited with actor information
 */
router.patch(
    "/password",
    authMW("private"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(changePasswordFormSchema),
    transactionHandler(),
    asyncHandler(passwordUpdate)
);
/**
 * Changes user password after validating current password.
 * 
 * @param params - Transaction, form, and authenticated parameters
 * @returns Success message
 */
async function passwordUpdate(params: TransactionRequiredParams & ChangePasswordFormType & AuthenticatedMWType): Promise<ChangePasswordFormResponseType> {
    const { newPassword, currentPassword, parentBypass, languageCode, logger, userInfo, session, company, actionUserCtx } = params;

    logger.start(`Trying to change password...`);
    SchemaGuard.sanitizeFields(User, {password: {}}, "write", actionUserCtx, languageCode);

    if (!parentBypass) {
        await userInfo.checkPassword(company._id, currentPassword, languageCode);
    }

    let user = await userService.findById(userInfo._id, { logger, languageCode, session });
    user.password = newPassword;
    user.$locals = user.$locals || {};
    user.$locals.auditUserId = new ObjectId(actionUserCtx.userId);
    await user.save({session});
    await user.resetUnsuccessfulLogins(company._id, session);

    logger.finish(`Password successfully changed!`);

    return {
        message: "Password successfully changed"
    };
}


export { router };

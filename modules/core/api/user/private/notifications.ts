/**
 * Notification Endpoints (Private)
 *
 * This module provides private RESTful endpoints for user notifications:
 * - POST "" — Paginated list of notifications for the current user
 * - GET /unread-count — Unread notification count for badge display
 * - PATCH /read — Mark notifications as read (by ids or all)
 * - DELETE "" — Delete notifications (by ids or all); uses soft delete
 *
 * All endpoints require authentication.
 *
 * @module f_endpoints/core/user/private/notifications
 */

import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {transactionHandler} from "@coreModule/utilities/middlewares/transactionHandler";
import {TransactionRequiredParams} from "@coreModule/utilities/middlewares/transactionUtils";
import authMW, {AuthenticatedMWType} from "@coreModule/utilities/middlewares/authMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {notificationService} from "@coreModule/database/schemas/notification/notification.service";
import {notificationsToDTO} from "@coreModule/utilities/mappers/notification/notificationMapper.dto";
import {
    ListNotificationsFormType
} from "armonia/src/modules/core/api/user/private/notifications/listNotifications.form.type";
import {
    listNotificationsFormSchema
} from "armonia/src/modules/core/api/user/private/notifications/listNotifications.form.validator";
import {
    MarkNotificationsReadFormType
} from "armonia/src/modules/core/api/user/private/notifications/markNotificationsRead.form.type";
import {
    markNotificationsReadFormSchema
} from "armonia/src/modules/core/api/user/private/notifications/markNotificationsRead.form.validator";
import {
    DeleteNotificationsFormType
} from "armonia/src/modules/core/api/user/private/notifications/deleteNotifications.form.type";
import {
    deleteNotificationsFormSchema
} from "armonia/src/modules/core/api/user/private/notifications/deleteNotifications.form.validator";
import {
    MarkNotificationsReadFormResponseType
} from "armonia/src/modules/core/api/user/private/notifications/markNotificationsRead.form.response.type";
import {schemaSanitizer, SchemaSanitizerMWType} from "@coreModule/utilities/middlewares/schemaSanitizerMW";
import {dslFilterMW, DslFilterMWType} from "@coreModule/utilities/middlewares/dslFilterMW";
import SchemaGuard from "@coreModule/database/security/schemaGuard";
import Notification from "@coreModule/database/schemas/notification/notification";
import {
    UnreadNotificationsFormResponseType
} from "armonia/src/modules/core/api/user/private/notifications/unreadNotifications.form.response.type";
import {ActionMessage, TableResponse} from "armonia/src/modules/core/types/shared.types";
import {NotificationType} from "armonia/src/modules/core/api/user/private/notifications/notifications.dto";

const router = Router();

/**
 * POST /api/user/notifications
 *
 * Returns paginated list of notifications for the authenticated user.
 *
 * @route POST /api/user/notifications
 * @access Private
 * @body {ListNotificationsFormType} - offset, limit, unreadOnly?, category?, filter?
 * @returns {Promise<ListNotificationsFormResponseType>} { data, total }
 *
 * @remarks
 * - Uses params.sanitizedReadFields from schemaSanitizer for field projection
 * - Supports filtering by unreadOnly, category, and Filter DSL (filter)
 */
router.post(
    "",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 120 }),
    validateFormZod(listNotificationsFormSchema),
    schemaSanitizer({ model: "notifications", requiredModes: ["read"] }),
    dslFilterMW({ model: "notifications" }),
    asyncHandler(listNotifications)
);
type ListNotificationsType = AuthenticatedMWType & SchemaSanitizerMWType & DslFilterMWType;
/**
 * Fetches paginated notifications for the current user.
 *
 * @param params - Auth context, sanitizedReadFields, dslFilterQuery, form (offset, limit, unreadOnly?, category?, filter?)
 * @returns { data, total } — notification DTOs and total count
 * @remarks Uses params.sanitizedReadFields from schemaSanitizer; merges params.dslFilterQuery into base filter
 */
async function listNotifications(params: ListNotificationsType & ListNotificationsFormType): Promise<TableResponse<NotificationType>> {
    const { logger, userInfo, company, languageCode, unreadOnly, category, offset, limit, sanitizedReadFields, dslFilterQuery } = params;

    logger.start(`Listing notifications for user ${userInfo._id.toString()}...`);

    const filter: Record<string, unknown> = {
        receiver: userInfo._id,
        company: company._id
    };
    if (unreadOnly) {
        filter.readOn = {
            $in: [null, undefined]
        };
    }
    if (category) {
        filter.category = category;
    }
    if (dslFilterQuery && Object.keys(dslFilterQuery as object).length > 0) {
        filter.$and = [...((filter.$and as unknown[]) ?? []), dslFilterQuery];
    }

    const populate = SchemaGuard.generatePopulate(sanitizedReadFields, Notification.schema);
    const [notifications, total] = await Promise.all([
        notificationService.find(
            filter,
            { logger, languageCode },
            populate.populate,
            populate.select,
            { date: -1 },
            limit,
            offset
        ),
        notificationService.count(filter, { logger, languageCode })
    ]);

    logger.finish(`Listed ${notifications.length} of ${total} notifications`);

    return {
        data: notificationsToDTO(notifications),
        total
    };
}

/**
 * GET /api/user/notifications/unread-count
 *
 * Returns the unread notification count for badge display.
 *
 * @route GET /api/user/notifications/unread-count
 * @access Private
 * @returns {Promise<UnreadNotificationsFormResponseType>} Unread count
 */
router.get(
    "/unread-count",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 60 }),
    asyncHandler(getUnreadCount)
);
/**
 * Returns unread notification count for the current user.
 *
 * @param params - Auth context
 * @returns { count } — number of unread notifications
 */
async function getUnreadCount(params: AuthenticatedMWType): Promise<UnreadNotificationsFormResponseType> {
    const { logger, userInfo, company, languageCode } = params;

    const unreadNotifications = await notificationService.count(
        {
            receiver: userInfo._id,
            company: company._id,
            readOn: { $in: [null, undefined] }
        },
        { logger, languageCode }
    );

    return { unreadNotifications };
}

/**
 * PATCH /api/user/notifications/read
 *
 * Marks notifications as read (by ids or all). Updates only unread notifications.
 *
 * @route PATCH /api/user/notifications/read
 * @access Private
 * @requires Transaction
 * @body {MarkNotificationsReadFormType} - ids?, all?
 * @returns {Promise<MarkNotificationsReadFormResponseType>} { updated }
 *
 * @remarks
 * - If ids provided: marks specified notifications as read (must belong to user)
 * - If all: true: marks all unread notifications for user as read
 * - Changes are audited with actionUserCtx.userId as the actor
 */
router.patch(
    "/read",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 30 }),
    validateFormZod(markNotificationsReadFormSchema),
    transactionHandler(),
    asyncHandler(markNotificationsRead)
);
type MarkNotificationsReadType = TransactionRequiredParams & AuthenticatedMWType;
/**
 * Marks notifications as read for the current user.
 *
 * @param params - Transaction, auth context, form (ids?, all?)
 * @returns { updated } — count of notifications marked as read
 * @remarks Requires ids or all in body; uses auditUserId from actionUserCtx.userId
 */
async function markNotificationsRead(params: MarkNotificationsReadType & MarkNotificationsReadFormType): Promise<MarkNotificationsReadFormResponseType> {
    const { logger, userInfo, company, languageCode, ids, all, actionUserCtx, session } = params;

    logger.start(`Marking notifications as read for user ${userInfo._id.toString()}...`);

    const filter: Record<string, unknown> = {
        receiver: userInfo._id,
        company: company._id,
        readOn: {
            $in: [null, undefined]
        }
    };

    if (all) {
        // Mark all unread as read
    }
    else if (ids && ids.length > 0) {
        filter._id = {
            $in: ids.map((id) => new ObjectId(id)) };
    }
    else {
        return { updated: 0 };
    }

    const result = await notificationService.updateMany(
        filter,
        { $set: { readOn: new Date() } },
        { session, logger, languageCode, auditUserId: actionUserCtx.userId }
    );

    logger.finish(`Marked ${result.modifiedCount} notifications as read`);

    return { updated: result.modifiedCount };
}

/**
 * DELETE /api/user/notifications
 *
 * Deletes notifications for the current user (by ids or all). Uses soft delete.
 *
 * @route DELETE /api/user/notifications
 * @access Private
 * @requires Transaction
 * @body {DeleteNotificationsFormType} - ids?, all?
 * @returns {Promise<DeleteNotificationsFormResponseType>} Success message
 *
 * @throws {apiValidationException} If user lacks delete permission for Notification model
 *
 * @remarks
 * - If ids provided: deletes specified notifications (must belong to user)
 * - If all: true: deletes all notifications for user
 * - Changes are audited with actionUserCtx.userId as the actor
 */
router.delete(
    "",
    authMW("private"),
    rateLimiter({ windowMs: 60000, max: 30 }),
    validateFormZod(deleteNotificationsFormSchema),
    transactionHandler(),
    asyncHandler(deleteNotifications)
);
type DeleteNotificationsType = TransactionRequiredParams & AuthenticatedMWType;
/**
 * Deletes notifications for the current user.
 *
 * @param params - Transaction, auth context, form (ids?, all?)
 * @returns Success message
 * @remarks Uses auditUserId from actionUserCtx.userId; checks delete permission via SchemaGuard
 */
async function deleteNotifications(params: DeleteNotificationsType & DeleteNotificationsFormType): Promise<ActionMessage> {
    const { logger, userInfo, company, languageCode, ids, all, actionUserCtx, session } = params;

    logger.start(`Deleting notifications for user ${userInfo._id.toString()}...`);

    SchemaGuard.checkModelPermission(Notification, "delete", actionUserCtx, languageCode);

    const filter: Record<string, unknown> = {
        receiver: userInfo._id,
        company: company._id,
    };

    if (all) {
        // Delete all
    } else if (ids && ids.length > 0) {
        filter._id = {
            $in: ids.map((id) => new ObjectId(id))
        };
    } else {
        return { message: "No notifications deleted. None was specified!" };
    }

    await notificationService.deleteMany(filter, { session, logger, languageCode, auditUserId: actionUserCtx.userId });

    logger.finish(`Deleted notifications`);

    return {
        message: "Notifications successfully deleted!"
    };
}

export { router };

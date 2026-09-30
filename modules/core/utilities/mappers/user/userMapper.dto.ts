/**
 * DTO mapper for User → CompanyUserType.
 * Centralizes mapping logic used in company users list and user data endpoints.
 */

import type {IUser} from "@coreModule/database/schemas/user/user";
import type {SimpleBlankUser} from "armonia/src/modules/core/dto/user.dto";
import type {RoleSimple} from "armonia/src/modules/core/dto/role.dto";
import {SimpleBlankUserSnippet} from "@coreModule/database/schemas/user/user.snippets";
import {RoleSimpleSnippet} from "@coreModule/database/schemas/role/role.snippets";
import {mapSnippet, objectIdToString} from "@coreModule/utilities/mappers/common.mapper";
import {
    CompanyUserRequestsType,
    CompanyUserType
} from "armonia/src/modules/core/api/company/private/users/companyUser.dto";
import {mapLifeCycleToDTO, mapOwnershipToDTO} from "@coreModule/utilities/mappers/plugin/pluginMappers.dto";

function toDate(d: Date | string | null | undefined): Date | undefined {
    if (d == null) return undefined;
    return d instanceof Date ? d : new Date(d);
}

function mapRequests(req: IUser["requests"]): CompanyUserRequestsType | undefined {
    if (!req) return undefined;
    const out: CompanyUserRequestsType = {};
    if (req.activation) {
        out.activation = {
            email: req.activation.email,
            attempts: req.activation.attempts,
            date: toDate(req.activation.date),
            lockedUntil: toDate(req.activation.lockedUntil),
        };
    }
    if (req.passwordReset) {
        out.passwordReset = {
            opened: req.passwordReset.opened,
            attempts: req.passwordReset.attempts,
            date: toDate(req.passwordReset.date),
            lockedUntil: toDate(req.passwordReset.lockedUntil),
        };
    }
    if (req.mfaDeactivation) {
        out.mfaDeactivation = {
            attempts: req.mfaDeactivation.attempts,
            date: toDate(req.mfaDeactivation.date),
            lockedUntil: toDate(req.mfaDeactivation.lockedUntil),
        };
    }
    if (req.invitation) {
        const ib = req.invitation?.invitedBy;
        out.invitation = {
            opened: req.invitation.opened,
            attempts: req.invitation.attempts,
            lockedUntil: toDate(req.invitation.lockedUntil),
            invitedBy: mapSnippet<SimpleBlankUser>()(ib, SimpleBlankUserSnippet),
            invitedAt: toDate(req.invitation.invitedAt),
            invitationExpiresAt: toDate(req.invitation.invitationExpiresAt),
            accepted: req.invitation.accepted,
            acceptedAt: toDate(req.invitation.acceptedAt),
            welcomeMessage: req.invitation.welcomeMessage || undefined,
        };
    }
    return Object.keys(out).length ? out : undefined;
}

export function userToCompanyUserDTO(user: IUser | null | undefined): CompanyUserType | null {
    if (!user) return null;

    const role = (user.roles ?? []).shift();

    return {
        _id: user._id ? user._id.toString() : undefined,
        username: user.username,
        name: user.name,
        surname: user.surname,
        phoneNumber: user.phoneNumber,
        timezone: user.timezone,
        birthday: user.birthday ? toDate(user.birthday) : undefined,
        registerDate: user.registerDate ? toDate(user.registerDate) : undefined,
        roles: role.roles
            ? role.roles
                .map((r) => mapSnippet<RoleSimple>()(r, RoleSimpleSnippet))
                .filter((r): r is RoleSimple => r != null)
            : [],
        status: role?.active ?? "inactive",
        verified: Boolean(user.isEmailVerified),
        unverifiedEmail: user.requests?.activation?.email,
        emailVerifiedAt: user.emailVerifiedAt ? toDate(user.emailVerifiedAt) : undefined,
        online: Boolean(user.online),
        isBot: Boolean(user.isBot),
        mfaStatus: user.mfaStatus,
        requests: user.requests ? mapRequests(user.requests) : undefined,
        registeredFrom: mapSnippet<SimpleBlankUser>()(user.registeredFrom, SimpleBlankUserSnippet),
        photo: user.photo?._id ? objectIdToString(user.photo?._id) : undefined,
        cover: user.cover?._id ? objectIdToString(user.cover?._id) : undefined,
        lastLogin: role?.lastLogin ? toDate(role.lastLogin) : undefined,
        unsuccessfulLogins: role?.unsuccessfulLogins ?? undefined,
        lockedOutUntil: role?.lockedOutUntil ? toDate(role.lockedOutUntil) : undefined,
        ...mapOwnershipToDTO(user),
        ...mapLifeCycleToDTO(user),
    };
}

export function usersToCompanyUserDTO(users: IUser[]): CompanyUserType[] {
    if (!users?.length) return [];
    return users.map(userToCompanyUserDTO).filter((d): d is CompanyUserType => d != null);
}

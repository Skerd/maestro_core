import {Schema} from "mongoose";

export function applyUserIndexes(UserSchema: Schema): void {
    // Top-level field indexes
    UserSchema.index({ username: 1 });              // Already unique, but explicit index for clarity
    UserSchema.index({ registerDate: -1 });         // For sorting by registration date
    UserSchema.index({ registeredFrom: 1 });        // For finding users registered by another user
    UserSchema.index({ online: 1 });                // For finding online/offline users
    UserSchema.index({ isBot: 1 });                 // For filtering bots
    UserSchema.index({ name: 1 });                  // For name-based searches
    UserSchema.index({ surname: 1 });               // For surname-based searches
    UserSchema.index({ fullName: 1 });              // For fullName-based searches
    UserSchema.index({ timezone: 1 });              // For timezone-based queries
    UserSchema.index({ birthday: 1 });              // For birthday-based queries
    UserSchema.index({ phoneNumber: 1 });           // For phone number lookups
    UserSchema.index({ companies: 1 });             // For finding users by company
    UserSchema.index({ finance: 1 });               // For finance-related queries
    UserSchema.index({ accesses: 1 });              // For access/role-based queries
    UserSchema.index({ photo: 1 });                 // For photo reference queries
    UserSchema.index({ cover: 1 });                 // For cover reference queries
    UserSchema.index({ isEmailVerified: 1 });       // For filtering verified/unverified users
    UserSchema.index({ emailVerifiedAt: -1 });      // For sorting by verification date

    // // Embedded CompanyRole indexes (roles array)
    UserSchema.index({ "roles.company": 1 });                    // For finding users by company in embedded roles
    UserSchema.index({ "roles.rolesCount": 1 });                    // For finding users by rolesCount in embedded roles
    // UserSchema.index({ "roles.roles": 1 });                      // For finding users with specific roles
    // UserSchema.index({ "roles.active": 1 });                     // For filtering active/inactive embedded roles
    // UserSchema.index({ "roles.lockedOutUntil": 1 });             // For finding locked out embedded roles
    // UserSchema.index({ "roles.lastLogin": -1 });                 // For sorting by last login (most recent first)
    // UserSchema.index({ "roles.lastLogin": 1 });                  // For sorting by last login (oldest first)
    // UserSchema.index({ "roles.unsuccessfulLogins": 1 });         // For filtering by unsuccessful login attempts

    // Compound indexes for common query patterns
    UserSchema.index({ isEmailVerified: 1, online: 1 });        // Common filter combination
    UserSchema.index({ companies: 1, isEmailVerified: 1 });     // Company + verification status
    UserSchema.index({ name: 1, surname: 1 });                  // Full name searches

    // // Compound indexes for embedded CompanyRole (roles array)
    // UserSchema.index({ "roles.company": 1, "roles.active": 1 });                    // Company roles by active status
    // UserSchema.index({ "roles.company": 1, "roles.roles": 1 });                    // Company roles with specific role
    // UserSchema.index({ "roles.company": 1, "roles.active": 1, "roles.lastLogin": -1 }); // Active company roles sorted by login
    // UserSchema.index({ "roles.active": 1, "roles.lockedOutUntil": 1 });           // Active roles with lockout status
    // UserSchema.index({ "roles.company": 1, "roles.lockedOutUntil": 1 });          // Company roles by lockout status
    // UserSchema.index({ companies: 1, "roles.company": 1, "roles.active": 1 });    // Company + embedded role company + active status

    // Nested field indexes in requests object
    // MFA Deactivation
    UserSchema.index({ "requests.mfaDeactivation.opened": 1 });         // For filtering open deactivation requests
    UserSchema.index({ "requests.mfaDeactivation.code": 1 });           // For code lookups
    UserSchema.index({ "requests.mfaDeactivation.date": -1 });          // For sorting by date
    UserSchema.index({ "requests.mfaDeactivation.lockedUntil": 1 });    // For lockout queries

    // Password Reset
    UserSchema.index({ "requests.passwordReset.opened": 1 });       // For filtering open reset requests
    UserSchema.index({ "requests.passwordReset.code": 1 });         // For code lookups
    UserSchema.index({ "requests.passwordReset.date": -1 });        // For sorting by date
    UserSchema.index({ "requests.passwordReset.lockedUntil": 1 });  // For lockout queries

    // Activation
    UserSchema.index({ "requests.activation.code": 1 });        // For code lookups
    UserSchema.index({ "requests.activation.date": -1 });       // For sorting by date
    UserSchema.index({ "requests.activation.lockedUntil": 1 }); // For lockout queries

    // Telegram
    UserSchema.index({ "requests.telegram.code": 1 }); // For code lookups

    // Invitation
    UserSchema.index({ "requests.invitation.opened": 1 });              // For filtering open invitations
    UserSchema.index({ "requests.invitation.code": 1 });                // For code lookups
    UserSchema.index({ "requests.invitation.invitedBy": 1 });           // For finding invitations by inviter
    UserSchema.index({ "requests.invitation.accepted": 1 });            // For filtering accepted/pending invitations
    UserSchema.index({ "requests.invitation.date": -1 });               // For sorting by invitation date
    UserSchema.index({ "requests.invitation.invitedAt": -1 });          // For sorting by invitation timestamp
    UserSchema.index({ "requests.invitation.invitationExpiresAt": 1 }); // For finding expired invitations
    UserSchema.index({ "requests.invitation.acceptedAt": -1 });         // For sorting by acceptance date
    UserSchema.index({ "requests.invitation.lockedUntil": 1 });         // For lockout queries

    // Compound indexes for nested fields
    UserSchema.index({ "requests.invitation.invitedBy": 1, "requests.invitation.accepted": 1 });            // Inviter + acceptance status
    UserSchema.index({ "requests.invitation.invitationExpiresAt": 1, "requests.invitation.accepted": 1 });  // Expired + acceptance status
}

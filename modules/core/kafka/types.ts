/**
 * Kafka Message Types
 *
 * Type definitions for Kafka messages used in the application.
 * All events follow a consistent structure with eventType, userId, and timestamp.
 * 
 * @module kafka/types
 */

import {ActionException} from "armonia/src/modules/core/types";

/**
 * Login history event - tracks user authentication attempts
 * 
 * Published when a user attempts to log in (successful or failed).
 * Used for audit logging, security monitoring, and analytics.
 * 
 * @property eventType - Always 'login_history'
 * @property userId - ID of the user attempting to log in
 * @property companyId - ID of the company the user belongs to
 * @property userAgent - Browser/client user agent string
 * @property requestIP - IP address of the login request
 * @property userMfaEnabled - Whether MFA is enabled for this user
 * @property timestamp - Unix timestamp in milliseconds
 * @property error - ActionException if login failed, null if successful
 */
export interface LoginHistoryEvent {
    eventType: 'login_history';
    userId: string;
    companyId: string;
    userAgent: string;
    requestIP: string;
    userMfaEnabled: boolean;
    timestamp: number;
    error: ActionException | null;
}

/**
 * Activation email event - triggers account activation email
 * 
 * Published when a new user account needs to be activated.
 * The consumer will send an activation email with the provided code.
 * 
 * @property eventType - Always 'activation_email'
 * @property email - Email address to send activation code to
 * @property userId - ID of the user to activate
 * @property fullName - Full name of the user
 * @property activationCode - Code to include in the activation email
 * @property languageCode - Language code for email localization (e.g., 'en-US', 'sq-AL')
 * @property timestamp - Unix timestamp in milliseconds
 */
export interface ActivationEmailEvent {
    eventType: 'activation_email';
    email: string;
    userId: string;
    fullName: string;
    activationCode: string;
    languageCode: string;
    timestamp: number;
    /** Company whose SMTP servers are used; falls back to env when omitted. */
    companyId?: string;
}

/**
 * MFA disable email event - triggers MFA disable notification email
 * 
 * Published when a user's MFA is being disabled.
 * The consumer will send a notification email to inform the user.
 * 
 * @property eventType - Always 'mfa_disable_email'
 * @property email - Email address to send notification to
 * @property userId - ID of the user whose MFA is being disabled
 * @property fullName - Full name of the user
 * @property resetCode - Reset code (if applicable)
 * @property languageCode - Language code for email localization
 * @property timestamp - Unix timestamp in milliseconds
 */
export interface MFADisableEmailEvent {
    eventType: 'mfa_disable_email';
    email: string;
    userId: string;
    fullName: string;
    resetCode: string;
    languageCode: string;
    timestamp: number;
    companyId?: string;
}

/**
 * Forgot password email event - triggers password reset email
 * 
 * Published when a user requests a password reset.
 * The consumer will send a password reset email with the provided code.
 * 
 * @property eventType - Always 'forgot_password_email'
 * @property email - Email address to send reset code to
 * @property userId - ID of the user requesting password reset
 * @property fullName - Full name of the user
 * @property resetCode - Password reset code to include in email
 * @property expiresAfterOpening - Whether the reset code expires after first use
 * @property languageCode - Language code for email localization
 * @property timestamp - Unix timestamp in milliseconds
 */
export interface ForgotPasswordEmailEvent {
    eventType: 'forgot_password_email';
    email: string;
    userId: string;
    fullName: string;
    resetCode: string;
    expiresAfterOpening: boolean;
    languageCode: string;
    timestamp: number;
    companyId?: string;
}

/**
 * Invitation email event - triggers user invitation email
 * 
 * Published when a new user is invited to join a company.
 * The consumer will send an invitation email with welcome message and invitation code.
 * 
 * @property eventType - Always 'invitation_email'
 * @property email - Email address to send invitation to
 * @property userId - ID of the invited user
 * @property fullName - Full name of the invited user
 * @property welcomeMessage - Custom welcome message from the inviter
 * @property invitationCode - Invitation code to include in email
 * @property inviterName - Name of the user sending the invitation
 * @property companyName - Name of the company the user is being invited to
 * @property languageCode - Language code for email localization
 * @property timestamp - Unix timestamp in milliseconds
 */
export interface InvitationEmailEvent {
    eventType: 'invitation_email';
    email: string;
    userId: string;
    fullName: string;
    welcomeMessage: string;
    invitationCode: string;
    inviterName: string;
    companyName: string;
    languageCode: string;
    timestamp: number;
    companyId?: string;
}

/**
 * API access event - tracks HTTP API requests for audit and analytics
 *
 * Published when an API endpoint is called. Used for audit logging,
 * usage analytics, performance monitoring, and security tracking.
 *
 * @property eventType - Always 'api_access'
 * @property endpoint - API path/route that was called
 * @property method - HTTP method (e.g. GET, POST, PUT, DELETE)
 * @property statusCode - HTTP response status code
 * @property duration - Request duration in milliseconds
 * @property errorType - Optional error type/code when the request failed
 * @property actionUser - ID of the user performing the action
 * @property actionNumber - Action/request sequence or correlation identifier
 * @property user - Target user context (e.g. user ID) for the request
 * @property company - Company/organization context for the request
 * @property deviceId - Client device identifier
 * @property userAgent - Browser/client user agent string
 * @property requestIp - IP address of the request
 * @property source - Origin or client source of the request (e.g. web, mobile)
 */
export interface ApiAccessEvent {
    eventType: 'api_access';
    endpoint: string;
    method: string;
    statusCode: number;
    duration: number;
    errorType?: string;
    actionUser: string,
    actionNumber: string,
    user: string,
    company: string,
    deviceId: string,
    userAgent: string,
    requestIp: string,
    source: string,
    timestamp: number
}

/**
 * Generic Kafka message wrapper
 * 
 * Used for type-safe Kafka message handling.
 * 
 * @template T - Type of the message value/payload
 * 
 * @property key - Message key (typically user ID for partitioning)
 * @property value - Message payload/value
 * @property headers - Optional message headers (metadata)
 * @property timestamp - Optional message timestamp
 */
export interface KafkaMessage<T = any> {
    key?: string;
    value: T;
    headers?: Record<string, string>;
    timestamp?: string;
}


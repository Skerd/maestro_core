import axios from "axios";
import {IP_INFO} from "@coreModule/environment";
import LoginHistory from "@coreModule/database/schemas/loginHistory/loginHistory";
import {ClientSession, ObjectId} from "mongodb";
import {
    ActivationEmailEvent,
    ForgotPasswordEmailEvent,
    InvitationEmailEvent,
    LoginHistoryEvent,
    MFADisableEmailEvent
} from "@coreModule/kafka/types";
import {
    sendForgetPasswordMail,
    sendInvitationMail,
    sendMfaDeactivationMail,
    sendSignUpMail
} from "@coreModule/utilities/emails/notifiers";
import {resolveCompanyIdForEmail} from "@coreModule/utilities/emails/mailDeliveryService";

const UAParser = require('ua-parser-js');

export async function AddToLoginHistory(data: LoginHistoryEvent, session?: ClientSession): Promise<void>{

    let {userId, userAgent, requestIP, userMfaEnabled, timestamp, error} = data;

    const parser = new UAParser(userAgent);
    const result = parser.getResult();

    let geolocation: any = {};
    try {
        if( IP_INFO.ENABLED ){
            const response = await axios.get(`https://ipinfo.io/${requestIP}/json?token=${IP_INFO.TOKEN}`);
            geolocation = response.data;
        }
    } catch (error) {}

    await new LoginHistory({
        user: new ObjectId(userId),
        time: new Date(timestamp),
        status: !!error ? "failure" : "success",
        mfa: userMfaEnabled,
        reason: error ? error.error_code : null,
        device: result.device?.model || 'Unknown',
        os: `${result.os?.name || 'Unknown'} ${result.os?.version || ''}`.trim(),
        browser: `${result.browser?.name || "Unknown"} ${result.browser?.version || "Unknown"}`,
        userAgent: userAgent || "Unknown",
        ip: requestIP,
        geolocation,
        company: data.companyId
    }).save({session});

}

export async function SendActivationEmail(data: ActivationEmailEvent, session?: ClientSession): Promise<void> {
    const {email, fullName, languageCode, activationCode, userId, companyId} = data;
    const resolvedCompanyId = await resolveCompanyIdForEmail(userId, companyId);
    await sendSignUpMail(
        resolvedCompanyId,
        email,
        fullName,
        activationCode,
        languageCode
    );

}

export async function SendMfaDisableEmail(data: MFADisableEmailEvent, session?: ClientSession): Promise<void> {
    const {email, fullName, languageCode, resetCode, userId, companyId} = data;
    const resolvedCompanyId = await resolveCompanyIdForEmail(userId, companyId);

    await sendMfaDeactivationMail(
        resolvedCompanyId,
        email,
        resetCode,
        fullName,
        languageCode
    );
}

export async function SendForgotPasswordEmail(data: ForgotPasswordEmailEvent, session?: ClientSession): Promise<void> {
    const {email, fullName, expiresAfterOpening, languageCode, resetCode, userId, companyId} = data;
    const resolvedCompanyId = await resolveCompanyIdForEmail(userId, companyId);
    await sendForgetPasswordMail(
        resolvedCompanyId,
        email,
        resetCode,
        fullName,
        expiresAfterOpening,
        languageCode
    );
}

export async function SendInvitationEmail(data: InvitationEmailEvent, session?: ClientSession): Promise<void> {
    const {email, fullName, welcomeMessage, invitationCode, inviterName, companyName, languageCode, userId, companyId} = data;
    const resolvedCompanyId = await resolveCompanyIdForEmail(userId, companyId);
    await sendInvitationMail(
        resolvedCompanyId,
        email,
        invitationCode,
        fullName,
        welcomeMessage,
        inviterName,
        companyName,
        languageCode
    );
}


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
import {getLogger, serverLogger} from "@coreModule/loggers/serverLog";
import {isKafkaConnected} from "@coreModule/connections/connectToKafka";

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
    } catch (error) {
        getLogger("user_login_history").debug(
            `IP geolocation lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

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
    const {email, fullName, languageCode, activationCode, userId, companyId, origin, next} = data;
    const resolvedCompanyId = await resolveCompanyIdForEmail(userId, companyId);
    await sendSignUpMail(
        resolvedCompanyId,
        email,
        fullName,
        activationCode,
        languageCode,
        origin,
        next,
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
    const {email, fullName, expiresAfterOpening, languageCode, resetCode, userId, companyId, origin} = data;
    const resolvedCompanyId = await resolveCompanyIdForEmail(userId, companyId);
    await sendForgetPasswordMail(
        resolvedCompanyId,
        email,
        resetCode,
        fullName,
        expiresAfterOpening,
        languageCode,
        origin,
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


/**
 * Sends an account email (activation, invitation, password reset, MFA deactivation) once the write that stored its
 * code is durable (D06, BE-08): after `session`'s transaction commits, or right away when the caller wrote without a
 * session (that write is already committed). A rolled-back request therefore never mails a link that does not exist.
 *
 * The email goes through Kafka when it is connected (not awaited, so a slow broker never delays the response) and
 * directly when the publish fails or Kafka is off. A failed send is logged, never thrown: the request has already
 * succeeded, and the user can ask for the email again.
 */
export async function sendAccountEmailAfterCommit(
    session: ClientSession | undefined,
    logger: serverLogger | undefined,
    kind: string,
    publish: () => Promise<boolean>,
    sendDirectly: () => Promise<void>,
): Promise<void> {
    const log = logger ?? getLogger("account_email");
    const reportFailure = (error: unknown) => log.err(`Could not send the ${kind} email`, error);
    const deliver = async (): Promise<void> => {
        if (isKafkaConnected()) {
            publish()
                .then(async (published) => { if (!published) await sendDirectly(); })
                .catch(reportFailure);
            return;
        }
        try {
            await sendDirectly();
        } catch (error) {
            reportFailure(error);
        }
    };
    if (!session) return deliver();
    // Loaded on use: `transactionUtils` reaches the database initializer, which the User model must not load.
    const {runAfterCommit} = await import("@coreModule/utilities/middlewares/transactionUtils");
    await runAfterCommit(session, deliver);
}

import * as fs from "fs";
import * as path from "path";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {CLIENT_SIDE, CONSTANTS, EMAIL} from "@coreModule/environment";
import {applyPlaceholders, loadEmailStrings} from "./emailLocale";
import {sendMail} from "./mailDeliveryService";

const forgotPasswordImagePath = path.join(__dirname, "./static/images/image-1.png");
const imageCID = "imageCID@example.com";
const fallbackLanguageCode = "en-US";

function canSendEmails(): boolean {
    return EMAIL.ENABLED;
}

function readTemplateHtml(templateDir: string, filename: string): string {
    return fs.readFileSync(path.join(templateDir, filename), "utf8");
}

async function deliverOrThrow(
    companyId: string | undefined,
    mailOptions: Parameters<typeof sendMail>[1],
    languageCode: string,
    errorField: string,
): Promise<void> {
    try {
        await sendMail(companyId, mailOptions);
    } catch {
        throw apiValidationException("could_not_send_email", errorField, null, languageCode);
    }
}

export async function sendInvitationMail(
    companyId: string | undefined,
    email: string,
    invitationCode: string,
    fullName: string,
    welcomeMessage: string,
    inviterName: string,
    companyName: string,
    languageCode: string = CONSTANTS.DEFAULT_LANGUAGE ?? fallbackLanguageCode,
): Promise<void> {
    if (!canSendEmails()) {
        return;
    }

    const pageName = CLIENT_SIDE.NAME ?? "";
    const templateDir = path.join(__dirname, "./templates/invitation");
    const strings = loadEmailStrings(["invitation"], languageCode);
    let emailTemplate = readTemplateHtml(templateDir, "invitation.html");

    emailTemplate = applyPlaceholders(emailTemplate, {
        heading: strings.heading ?? "",
        body: strings.body ?? "",
        ctaBefore: strings.ctaBefore ?? "",
        ctaLink: strings.ctaLink ?? "",
        ctaAfter: strings.ctaAfter ?? "",
        imageAlt: strings.imageAlt ?? "",
        copyright: strings.copyright ?? "",
    });

    const activationUrl = CLIENT_SIDE.HOST + "/authenticate/acceptInvitation/" + invitationCode;
    emailTemplate = emailTemplate.replace(/http:\/\/1234\.html/g, activationUrl);
    emailTemplate = applyPlaceholders(emailTemplate, {
        username: fullName,
        welcomeMessage: welcomeMessage || "",
        inviterName,
        companyName,
        pageName,
    });

    const subject = applyPlaceholders(strings.subject ?? "", {pageName});

    await deliverOrThrow(
        companyId,
        {
            to: email,
            subject,
            html: emailTemplate,
            attachments: [
                {
                    filename: "companyTick.png",
                    path: forgotPasswordImagePath,
                    cid: imageCID,
                },
            ],
        },
        languageCode,
        "invitation_email",
    );
}

export async function sendSignUpMail(
    companyId: string | undefined,
    email: string,
    username: string,
    activationCode: string,
    languageCode: string = CONSTANTS.DEFAULT_LANGUAGE ?? fallbackLanguageCode,
): Promise<void> {
    if (!canSendEmails()) {
        return;
    }

    const pageName = CLIENT_SIDE.NAME ?? "";
    const templateDir = path.join(__dirname, "./templates/activateAccount");
    const strings = loadEmailStrings(["activateAccount"], languageCode);
    let emailTemplate = readTemplateHtml(templateDir, "activateAccount.html");

    emailTemplate = applyPlaceholders(emailTemplate, {
        heading: strings.heading ?? "",
        bodyBefore: strings.bodyBefore ?? "",
        bodyLink: strings.bodyLink ?? "",
        bodyAfter: strings.bodyAfter ?? "",
        imageAlt: strings.imageAlt ?? "",
        copyright: strings.copyright ?? "",
    });

    const activationUrl = CLIENT_SIDE.HOST + "/authenticate/activateAccount/" + activationCode;
    emailTemplate = emailTemplate.replace(/http:\/\/1234\.html/g, activationUrl);
    emailTemplate = applyPlaceholders(emailTemplate, {
        username,
        pageName,
    });

    const subject = applyPlaceholders(strings.subject ?? "", {pageName});

    await deliverOrThrow(
        companyId,
        {
            to: email,
            subject,
            html: emailTemplate,
            attachments: [
                {
                    filename: "companyTick.png",
                    path: forgotPasswordImagePath,
                    cid: imageCID,
                },
            ],
        },
        languageCode,
        "activation_email",
    );
}

export async function sendForgetPasswordMail(
    companyId: string | undefined,
    email: string,
    resetPasswordCode: string,
    username: string,
    expiresAfterOpening: boolean,
    languageCode: string = CONSTANTS.DEFAULT_LANGUAGE ?? fallbackLanguageCode,
): Promise<void> {
    if (!canSendEmails()) {
        return;
    }

    const pageName = CLIENT_SIDE.NAME ?? "";
    const templateDir = path.join(__dirname, "./templates/forgotPassword");
    const strings = loadEmailStrings(["forgotPassword"], languageCode);
    let emailTemplate = readTemplateHtml(templateDir, "resetPasswordRequest.html");

    const securityReasons = expiresAfterOpening
        ? (strings.securityOnceOpen ?? "")
        : (strings.security24h ?? "");

    emailTemplate = applyPlaceholders(emailTemplate, {
        heading: strings.heading ?? "",
        introBefore: strings.introBefore ?? "",
        introLink: strings.introLink ?? "",
        introAfter: strings.introAfter ?? "",
        imageAlt: strings.imageAlt ?? "",
        copyright: strings.copyright ?? "",
        securityReasons,
    });

    const resetUrl = CLIENT_SIDE.HOST + "/authenticate/resetPassword/" + resetPasswordCode;
    emailTemplate = emailTemplate.replace(/http:\/\/1234\.html/g, resetUrl);
    emailTemplate = applyPlaceholders(emailTemplate, {
        username,
        pageName,
    });

    const subject = strings.subject ?? "";

    await deliverOrThrow(
        companyId,
        {
            to: email,
            subject,
            html: emailTemplate,
            attachments: [
                {
                    filename: "companyTick.png",
                    path: forgotPasswordImagePath,
                    cid: imageCID,
                },
            ],
        },
        languageCode,
        "forgetPassword_email",
    );
}

export async function sendMfaDeactivationMail(
    companyId: string | undefined,
    email: string,
    mfaDeactivationCode: string,
    username: string,
    languageCode: string = CONSTANTS.DEFAULT_LANGUAGE ?? fallbackLanguageCode,
): Promise<void> {
    if (!canSendEmails()) {
        return;
    }

    const pageName = CLIENT_SIDE.NAME ?? "";
    const templateDir = path.join(__dirname, "./templates/deactivateOtp");
    const strings = loadEmailStrings(["deactivateOtp"], languageCode);
    let emailTemplate = readTemplateHtml(templateDir, "deactivateOtp.html");

    emailTemplate = applyPlaceholders(emailTemplate, {
        heading: strings.heading ?? "",
        bodyBefore: strings.bodyBefore ?? "",
        bodyLink: strings.bodyLink ?? "",
        bodyAfter: strings.bodyAfter ?? "",
        imageAlt: strings.imageAlt ?? "",
        copyright: strings.copyright ?? "",
    });

    const deactivateUrl = CLIENT_SIDE.HOST + "/authenticate/deactivateOTP/" + mfaDeactivationCode;
    emailTemplate = emailTemplate.replace(/http:\/\/1234\.html/g, deactivateUrl);
    emailTemplate = applyPlaceholders(emailTemplate, {
        username,
        pageName,
    });

    const subject = strings.subject ?? "";

    await deliverOrThrow(
        companyId,
        {
            to: email,
            subject,
            html: emailTemplate,
            attachments: [
                {
                    filename: "companyTick.png",
                    path: forgotPasswordImagePath,
                    cid: imageCID,
                },
            ],
        },
        languageCode,
        "mfa_disable_email",
    );
}

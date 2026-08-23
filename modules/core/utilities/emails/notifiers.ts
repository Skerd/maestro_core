import * as fs from "fs";
import * as path from "path";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {CLIENT_SIDE, CONSTANTS, EMAIL} from "@coreModule/environment";
import {applyPlaceholders, loadEmailStrings, type EmailStrings} from "./emailLocale";
import {sendMail} from "./mailDeliveryService";

const fallbackLanguageCode = "en-US";

function canSendEmails(): boolean {
    return EMAIL.ENABLED;
}

function readTemplateHtml(templateDir: string, filename: string): string {
    return fs.readFileSync(path.join(templateDir, filename), "utf8");
}

/**
 * Slots shared by every core auth template (`templates/*` all use the same layout).
 * `note` is the highlighted security strip; templates that vary it (e.g. forgot
 * password) pass an override.
 */
function layoutStrings(strings: EmailStrings, noteOverride?: string): Record<string, string> {
    return {
        htmlLang: strings.htmlLang ?? "en",
        preheader: strings.preheader ?? "",
        heading: strings.heading ?? "",
        greeting: strings.greeting ?? "",
        body: strings.body ?? "",
        ctaLabel: strings.ctaLabel ?? "",
        fallbackLabel: strings.fallbackLabel ?? "",
        note: noteOverride ?? strings.note ?? "",
        ignore: strings.ignore ?? "",
        footerNote: strings.footerNote ?? "",
        copyright: strings.copyright ?? "",
    };
}

/** Removes an optional `<!-- name:start -->…<!-- name:end -->` section from a template. */
function removeOptionalBlock(html: string, name: string): string {
    const pattern = new RegExp(`\\s*<!--\\s*${name}:start\\s*-->[\\s\\S]*?<!--\\s*${name}:end\\s*-->`, "g");
    return html.replace(pattern, "");
}

/** Strips the marker comments while keeping the section they wrap. */
function keepOptionalBlock(html: string, name: string): string {
    return html.replace(new RegExp(`<!--\\s*${name}:(start|end)\\s*-->`, "g"), "");
}

function currentYear(): string {
    return new Date().getFullYear().toString();
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

    const trimmedWelcomeMessage = welcomeMessage?.trim() ?? "";
    emailTemplate = trimmedWelcomeMessage
        ? keepOptionalBlock(emailTemplate, "welcomeMessage")
        : removeOptionalBlock(emailTemplate, "welcomeMessage");

    emailTemplate = applyPlaceholders(emailTemplate, {
        ...layoutStrings(strings),
        welcomeMessageLabel: strings.welcomeMessageLabel ?? "",
    });

    const activationUrl = CLIENT_SIDE.HOST + "/authenticate/acceptInvitation/" + invitationCode;
    emailTemplate = emailTemplate.replace(/http:\/\/1234\.html/g, activationUrl);

    const values = {
        username: fullName,
        welcomeMessage: trimmedWelcomeMessage,
        inviterName,
        companyName,
        pageName,
        year: currentYear(),
    };
    emailTemplate = applyPlaceholders(emailTemplate, values);

    const subject = applyPlaceholders(strings.subject ?? "", values);

    await deliverOrThrow(
        companyId,
        {
            to: email,
            subject,
            html: emailTemplate,
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

    emailTemplate = applyPlaceholders(emailTemplate, layoutStrings(strings));

    const activationUrl = CLIENT_SIDE.HOST + "/authenticate/activateAccount/" + activationCode;
    emailTemplate = emailTemplate.replace(/http:\/\/1234\.html/g, activationUrl);

    const values = {
        username,
        pageName,
        year: currentYear(),
    };
    emailTemplate = applyPlaceholders(emailTemplate, values);

    const subject = applyPlaceholders(strings.subject ?? "", values);

    await deliverOrThrow(
        companyId,
        {
            to: email,
            subject,
            html: emailTemplate,
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

    emailTemplate = applyPlaceholders(emailTemplate, layoutStrings(strings, securityReasons));

    const resetUrl = CLIENT_SIDE.HOST + "/authenticate/resetPassword/" + resetPasswordCode;
    emailTemplate = emailTemplate.replace(/http:\/\/1234\.html/g, resetUrl);

    const values = {
        username,
        pageName,
        year: currentYear(),
    };
    emailTemplate = applyPlaceholders(emailTemplate, values);

    const subject = applyPlaceholders(strings.subject ?? "", values);

    await deliverOrThrow(
        companyId,
        {
            to: email,
            subject,
            html: emailTemplate,
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

    emailTemplate = applyPlaceholders(emailTemplate, layoutStrings(strings));

    const deactivateUrl = CLIENT_SIDE.HOST + "/authenticate/deactivateOTP/" + mfaDeactivationCode;
    emailTemplate = emailTemplate.replace(/http:\/\/1234\.html/g, deactivateUrl);

    const values = {
        username,
        pageName,
        year: currentYear(),
    };
    emailTemplate = applyPlaceholders(emailTemplate, values);

    const subject = applyPlaceholders(strings.subject ?? "", values);

    await deliverOrThrow(
        companyId,
        {
            to: email,
            subject,
            html: emailTemplate,
        },
        languageCode,
        "mfa_disable_email",
    );
}

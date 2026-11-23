/**
 * Messaging Dispatch Service
 *
 * Sends SMS and WhatsApp messages via Twilio REST API.
 * Called by the notification domain service when notification channels include "sms" or "whatsapp".
 */

import {findPlatformCompanyId} from "@coreModule/utilities/security/platformAccess";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import axios from "axios";
import {ObjectId} from "mongodb";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {CONSTANTS} from "@coreModule/environment";
import type {TestMessagingProviderConnectionResponse} from "armonia/src/modules/core/api/auxiliary/private/messagingProvider/messagingProvider.dto";
import type {IMessagingProvider} from "@coreModule/database/schemas/messagingProvider/messagingProvider";
import {messagingProviderService} from "@coreModule/database/schemas/messagingProvider/messagingProvider.service";
import {DecryptString, EncryptString} from "@coreModule/utilities/security/encryption";
import {isSandboxCompany} from "@coreModule/utilities/company/isSandboxCompany";

export interface SendMessageParams {
    to: string;       // E.164 phone number
    body: string;
    channel: "sms" | "whatsapp";
    /** The company the message is for; it goes out through the platform's provider either way (D161). */
    companyId: string | ObjectId;
}

export interface SendMessageResult {
    sid: string;
    status: string;
}

type MessagingProviderTestSource = Pick<
    IMessagingProvider,
    "accountSid" | "authTokenEncrypted" | "fromPhone" | "fromWhatsapp" | "name"
>;

/**
 * The provider that sends a company's messages: messaging providers are the platform's (D161), so it is the platform
 * company's active one, whichever company the message is for.
 */
async function getActiveProvider() {
    const platformId = await findPlatformCompanyId();
    if (!platformId) return null;
    // Read in the platform's tenant, whichever company's request or job sends the message.
    return withTenant(platformId, () => messagingProviderService.findOne(
        {company: platformId, active: true},
        {logger: undefined as any, languageCode: "en-US"},
    ));
}

function resolveTwilioErrorDetail(err: unknown): string {
    if (axios.isAxiosError(err)) {
        const data = err.response?.data as {message?: string} | undefined;
        if (data?.message?.trim()) return data.message.trim();
    }
    if (err instanceof Error && err.message.trim()) return err.message.trim();
    return "Messaging connection test failed";
}

function throwMessagingTestValidationError(err: unknown, languageCode: string): never {
    const lang = languageCode?.trim() || CONSTANTS.DEFAULT_LANGUAGE;
    throw apiValidationException("messaging_test_failed", "", null, lang, [resolveTwilioErrorDetail(err)]);
}

export async function testMessagingProviderConnection(
    provider: MessagingProviderTestSource,
    testPhone: string,
    languageCode: string = CONSTANTS.DEFAULT_LANGUAGE,
    authTokenOverride?: string,
): Promise<TestMessagingProviderConnectionResponse> {
    const authToken = authTokenOverride?.trim()
        || (provider.authTokenEncrypted ? DecryptString(provider.authTokenEncrypted) : null);
    if (!authToken) {
        throw apiValidationException("messaging_provider_auth_token_required", "", null, languageCode);
    }

    const fromPhone = provider.fromPhone?.trim();
    const fromWhatsapp = provider.fromWhatsapp?.trim();
    if (!fromPhone && !fromWhatsapp) {
        throw apiValidationException("messaging_provider_sender_required", "", null, languageCode);
    }

    const useWhatsapp = !fromPhone && !!fromWhatsapp;
    const from = useWhatsapp ? `whatsapp:${fromWhatsapp}` : fromPhone!;
    const toFormatted = useWhatsapp ? `whatsapp:${testPhone.trim()}` : testPhone.trim();
    const channelLabel = useWhatsapp ? "WhatsApp" : "SMS";
    const body = `[SYSTEM] ${channelLabel} test${provider.name?.trim() ? ` — ${provider.name.trim()}` : ""}`;

    try {
        const url = `https://api.twilio.com/2010-04-01/Accounts/${provider.accountSid}/Messages.json`;
        const response = await axios.post(
            url,
            new URLSearchParams({To: toFormatted, From: from, Body: body}).toString(),
            {
                auth: {username: provider.accountSid, password: authToken},
                headers: {"Content-Type": "application/x-www-form-urlencoded"},
                timeout: 10000,
            },
        );
        return {
            ok: true,
            message: `${channelLabel} test message sent (${response.data.status ?? "queued"}).`,
        };
    } catch (err) {
        throwMessagingTestValidationError(err, languageCode);
    }
}

/** Sends one SMS or WhatsApp message; `null` when nothing was sent (no provider or sender, or a sample company, D178). */
export async function sendMessagingNotification(params: SendMessageParams): Promise<SendMessageResult | null> {
    const {to, body, channel} = params;
    if (!to || !body) return null;
    // A sample company's people are demo people with real-looking numbers: nothing it does may text them.
    if (await isSandboxCompany(params.companyId)) return null;

    const provider = await getActiveProvider();
    if (!provider) return null;

    const authToken = provider.authTokenEncrypted
        ? DecryptString(provider.authTokenEncrypted)
        : null;
    if (!authToken) return null;

    const from = channel === "whatsapp"
        ? (provider.fromWhatsapp ? `whatsapp:${provider.fromWhatsapp}` : null)
        : provider.fromPhone;

    if (!from) return null;

    const toFormatted = channel === "whatsapp" ? `whatsapp:${to}` : to;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${provider.accountSid}/Messages.json`;
    const response = await axios.post(
        url,
        new URLSearchParams({To: toFormatted, From: from, Body: body}).toString(),
        {
            auth: {username: provider.accountSid, password: authToken},
            headers: {"Content-Type": "application/x-www-form-urlencoded"},
            timeout: 10000,
        }
    );

    return {sid: response.data.sid, status: response.data.status};
}

export function encryptProviderToken(token: string): string {
    return EncryptString(token);
}

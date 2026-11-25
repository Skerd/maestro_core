import nodemailer, {type Transporter} from "nodemailer";
import type {SendMailOptions as NodemailerSendMailOptions} from "nodemailer";
import {ObjectId} from "mongodb";
import {EMAIL, SERVER} from "@coreModule/environment";
import {getLogger} from "@coreModule/loggers/serverLog";
import type {ISmtpServer} from "@coreModule/database/schemas/smtpServer/smtpServer";
import {smtpServerService} from "@coreModule/database/schemas/smtpServer/smtpServer.service";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {DecryptString, EncryptString} from "@coreModule/utilities/security/encryption";
import type {SmtpAuthType, SmtpEncryptionType} from "armonia/src/modules/core/api/auxiliary/private/smtpServer/smtpServer.constants";
import {
    apiValidationException,
    DEFAULT_EXCEPTION_LANGUAGE,
} from "armonia/src/modules/core/helpers/exceptions";

const logger = getLogger("mailDeliveryService");

const CACHE_TTL_MS = 60_000;

type CacheEntry = {
    expiresAt: number;
    servers: ISmtpServer[];
};

const companyServerCache = new Map<string, CacheEntry>();

let envTransporter: Transporter | null = null;

export type MailDeliverySendOptions = Omit<NodemailerSendMailOptions, "from"> & {
    fromEmail?: string;
    fromName?: string;
};

export type SmtpConnectionConfig = {
    host: string;
    port: number;
    encryption: SmtpEncryptionType;
    authType: SmtpAuthType;
    username?: string;
    password?: string;
    fromEmail: string;
    fromName?: string;
    replyTo?: string;
};

export function invalidateCompanyMailCache(companyId?: ObjectId | string | null): void {
    if (companyId) {
        companyServerCache.delete(companyId.toString());
        // The name, email and suspension mail is sent with (D191) change with the company too.
        identityCache.delete(companyId.toString());
        return;
    }
    companyServerCache.clear();
    identityCache.clear();
}

export function encryptSmtpPassword(plain: string): string {
    return EncryptString(plain);
}

export function decryptSmtpPassword(encrypted: string): string {
    return DecryptString(encrypted);
}

function formatFromAddress(fromEmail: string, fromName?: string): string {
    if (fromName?.trim()) {
        return `"${fromName.replace(/"/g, '\\"')}" <${fromEmail}>`;
    }
    return fromEmail;
}

function buildNodemailerOptions(config: SmtpConnectionConfig): nodemailer.TransportOptions {
    const secure = config.encryption === "ssl";
    const options: nodemailer.TransportOptions = {
        host: config.host,
        port: config.port,
        secure,
        auth:
            config.authType === "login" && config.username
                ? {user: config.username, pass: config.password ?? ""}
                : undefined,
    };

    if (config.encryption === "starttls") {
        (options as any).requireTLS = true;
    }

    const rejectUnauthorized = SERVER.NODE_ENV === "production";
    (options as any).tls = {rejectUnauthorized};

    return options;
}

export function buildTransporter(config: SmtpConnectionConfig): Transporter {
    return nodemailer.createTransport(buildNodemailerOptions(config));
}

export function smtpServerToConnectionConfig(server: ISmtpServer, passwordOverride?: string): SmtpConnectionConfig {
    const password =
        passwordOverride ??
        (server.passwordEncrypted ? decryptSmtpPassword(server.passwordEncrypted) : undefined);

    return {
        host: server.host,
        port: server.port,
        encryption: server.encryption,
        authType: server.authType,
        username: server.username,
        password,
        fromEmail: server.fromEmail,
        fromName: server.fromName,
        replyTo: server.replyTo,
    };
}

async function loadActiveServers(companyId: ObjectId | string): Promise<ISmtpServer[]> {
    const key = companyId.toString();
    const cached = companyServerCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.servers;
    }

    // Read in the owner's tenant: the platform's servers are used on every company's behalf (D161).
    const servers = await withTenant(key, () => smtpServerService.findActiveInSequence(new ObjectId(key)));

    companyServerCache.set(key, {
        servers,
        expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return servers;
}

function getEnvTransporter(): Transporter | null {
    if (!EMAIL.ENABLED) {
        return null;
    }
    if (!envTransporter) {
        envTransporter = nodemailer.createTransport({
            host: EMAIL.SMTP_HOST,
            port: EMAIL.SMTP_PORT,
            secure: EMAIL.SMTP_SECURE,
            auth: {
                user: EMAIL.SMTP_USER,
                pass: EMAIL.SMTP_PASSWORD,
            },
            tls: {
                rejectUnauthorized: SERVER.NODE_ENV === "production",
            },
        });
    }
    return envTransporter;
}

function resolveFrom(
    mailOptions: MailDeliverySendOptions,
    config?: SmtpConnectionConfig,
): string {
    if (typeof mailOptions.from === "string" && mailOptions.from) {
        return mailOptions.from;
    }
    const email = mailOptions.fromEmail ?? config?.fromEmail ?? EMAIL.FROM_EMAIL;
    const name = mailOptions.fromName ?? config?.fromName ?? EMAIL.FROM_NAME;
    return formatFromAddress(email, name);
}

/** Returns nodemailer's send info so callers that need a message id can read it. */
async function sendViaTransporter(
    transporter: Transporter,
    mailOptions: MailDeliverySendOptions,
    config?: SmtpConnectionConfig,
): Promise<{messageId?: string}> {
    const {fromEmail: _fe, fromName: _fn, ...rest} = mailOptions;
    const info = await transporter.sendMail({
        ...rest,
        from: resolveFrom(mailOptions, config),
        replyTo: rest.replyTo ?? config?.replyTo ?? EMAIL.REPLY_TO_EMAIL,
    });
    return {messageId: info.messageId};
}

async function sendViaEnvFallback(mailOptions: MailDeliverySendOptions): Promise<{messageId?: string}> {
    const transporter = getEnvTransporter();
    if (!transporter) {
        return {};
    }
    return sendViaTransporter(transporter, mailOptions);
}

/**
 * Resolves company id for outbound mail when the event did not include one.
 */
export async function resolveCompanyIdForEmail(
    userId: string,
    companyId?: string,
): Promise<string | undefined> {
    if (companyId) {
        return companyId;
    }

    // Loaded at call time: the User and Company models import this module (their account emails), so a static
    // import of their services would build a service before its model exists.
    const [{userService}, {companyService}] = await Promise.all([
        import("@coreModule/database/schemas/user/user.service"),
        import("@coreModule/database/schemas/company/company.service"),
    ]);
    const user = await userService.findById(userId, {}, undefined, "roles.company requests.invitation.company");

    const invitationCompany = user?.requests?.invitation?.company;
    if (invitationCompany) {
        return invitationCompany.toString();
    }

    const roleCompany = user?.roles?.[0]?.company;
    if (roleCompany) {
        return roleCompany.toString();
    }

    const defaultCompany = await companyService.findOne({isDefaultForSignUp: true}, {}, undefined, "_id");
    return defaultCompany?._id?.toString();
}

/** How a message reaches its servers. */
export type MailDeliveryRoute = {
    /**
     * Send through the company's own mail servers (a module may let its companies keep some, e.g. for campaigns, D161),
     * falling back to the platform's when it has none. Every other mail goes through the platform's servers.
     */
    ownServers?: boolean;
};

type CompanyIdentity = {name?: string; email?: string; suspended?: boolean};
type CachedValue<T> = {expiresAt: number; value: T};

const identityCache = new Map<string, CachedValue<CompanyIdentity | null>>();
let platformCompanyCache: CachedValue<string | undefined> | null = null;

/** The platform company's id (its servers send every company's mail), cached like the servers. */
async function platformCompanyKey(): Promise<string | undefined> {
    if (platformCompanyCache && platformCompanyCache.expiresAt > Date.now()) return platformCompanyCache.value;
    // Loaded at call time, like resolveCompanyIdForEmail's services: the Company model imports this module.
    const {findPlatformCompanyId} = await import("@coreModule/utilities/security/platformAccess");
    const value = (await findPlatformCompanyId())?.toString();
    platformCompanyCache = {expiresAt: Date.now() + CACHE_TTL_MS, value};
    return value;
}

/** The name and email a company's mail is sent as and answered to. */
async function companyIdentity(companyKey: string): Promise<CompanyIdentity | null> {
    const cached = identityCache.get(companyKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const {companyService} = await import("@coreModule/database/schemas/company/company.service");
    const company = await companyService.findById(companyKey, {}, undefined, "name email suspendedAt");
    const value = company ? {name: company.name, email: company.email, suspended: Boolean(company.suspendedAt)} : null;
    identityCache.set(companyKey, {expiresAt: Date.now() + CACHE_TTL_MS, value});
    return value;
}

/**
 * Whether nothing may be mailed on the company's behalf: the platform suspended it (D191). The platform's own mail is
 * never held back.
 */
async function senderSuspended(companyKey: string): Promise<boolean> {
    if (companyKey === await platformCompanyKey()) return false;
    return (await companyIdentity(companyKey))?.suspended === true;
}

/**
 * A company's mail sent through the platform's servers: from the platform server's address under the company's name,
 * answered to the company (the caller's own reply-to or from address, else the company's email).
 */
function onBehalfOf(mail: MailDeliverySendOptions, identity: CompanyIdentity | null): MailDeliverySendOptions {
    const {fromEmail, ...rest} = mail;
    return {
        ...rest,
        fromName: mail.fromName ?? identity?.name,
        replyTo: mail.replyTo ?? fromEmail ?? identity?.email,
    };
}

/**
 * Which servers send a company's mail and as whom (D161): mail servers are the platform's, so every company's mail goes
 * through the platform company's servers, written as the company (`onBehalfOf`). A `route.ownServers` message (a
 * module's campaigns) uses the company's own servers as they are, and the platform's when the company has none.
 */
async function resolveSender(
    companyKey: string,
    route: MailDeliveryRoute,
): Promise<{servers: ISmtpServer[]; prepare: (mail: MailDeliverySendOptions) => MailDeliverySendOptions}> {
    if (route.ownServers) {
        const own = await loadActiveServers(companyKey);
        if (own.length > 0) return {servers: own, prepare: (mail) => mail};
    }
    const platformKey = await platformCompanyKey();
    const servers = platformKey ? await loadActiveServers(platformKey) : [];
    if (!platformKey || platformKey === companyKey) return {servers, prepare: (mail) => mail};
    const identity = await companyIdentity(companyKey);
    return {servers, prepare: (mail) => onBehalfOf(mail, identity)};
}

/**
 * Sends a company's mail through the platform's SMTP servers in sequence order (its own servers for a `route.ownServers`
 * message), then falls back to .env EMAIL_* settings. See {@link resolveSender} for who it is sent as.
 *
 * Resolves with the transport's message id, so a caller that must match later replies or bounces can store it.
 * The id is absent when nothing was sent: email is turned off (`EMAIL_ENABLED=false`), or no server took the mail.
 */
export async function sendMail(
    companyId: ObjectId | string | undefined | null,
    message: MailDeliverySendOptions,
    route: MailDeliveryRoute = {},
): Promise<{messageId?: string}> {
    if (!EMAIL.ENABLED) {
        return {};
    }

    if (!companyId) {
        return sendViaEnvFallback(message);
    }

    const companyKey = companyId.toString();
    if (await senderSuspended(companyKey)) {
        logger.warn(`Mail of suspended company ${companyKey} not sent (D191)`);
        return {};
    }
    const {servers, prepare} = await resolveSender(companyKey, route);
    const mailOptions = prepare(message);

    for (const server of servers) {
        try {
            const config = smtpServerToConnectionConfig(server);
            const transporter = buildTransporter(config);
            await transporter.verify();
            const sent = await sendViaTransporter(transporter, mailOptions, config);
            logger.debug(`Email sent via SMTP server ${server._id} (sequence=${server.sequence}) for company ${companyKey}`);
            return sent;
        } catch (err: any) {
            logger.warn(
                `SMTP server ${server._id} (sequence=${server.sequence}) failed for company ${companyKey}: ${err?.message ?? err}`,
            );
        }
    }

    try {
        const sent = await sendViaEnvFallback(mailOptions);
        logger.debug(`Email sent via environment SMTP fallback for company ${companyKey}`);
        return sent;
    } catch (err: any) {
        logger.err(`All SMTP servers and env fallback failed for company ${companyKey}: ${err?.message ?? err}`);
        throw err;
    }
}

/** Connections one pooled transport may hold open, and messages it may reuse them for. */
const POOL_MAX_CONNECTIONS = 5;
const POOL_MAX_MESSAGES = 100;

export type PooledMailSession = {
    send(mailOptions: MailDeliverySendOptions): Promise<{messageId?: string}>;
    close(): Promise<void>;
};

/**
 * A reusable SMTP session for sending many messages of one company (through the servers {@link resolveSender} picks).
 *
 * {@link sendMail} builds a transport **and calls `verify()` for every single
 * message**. That is the right trade for transactional mail — fire and forget,
 * no connection to manage — but for a campaign of a few thousand recipients it
 * means thousands of redundant TCP+TLS handshakes, which providers throttle,
 * tarpit or simply drop.
 *
 * This keeps one pooled, already-verified transport per configured server for
 * the life of a campaign drain, using the identical failover ladder and env
 * fallback as `sendMail`. `sendMail`'s own behaviour is deliberately untouched:
 * dozens of transactional call sites depend on it.
 *
 * Callers **must** `close()` (in a `finally`), or the pooled sockets stay open.
 */
export async function createPooledMailSession(
    companyId: ObjectId | string | undefined | null,
    route: MailDeliveryRoute = {},
): Promise<PooledMailSession> {
    const companyKey = companyId?.toString();
    // A suspended company's campaigns stop (D191): failing here marks their sends failed, never sent.
    if (companyKey && await senderSuspended(companyKey)) {
        throw new Error(`Company ${companyKey} is suspended: its mail is not sent (D191)`);
    }
    const {servers, prepare} = companyKey
        ? await resolveSender(companyKey, route)
        : {servers: [] as ISmtpServer[], prepare: (mail: MailDeliverySendOptions) => mail};

    // Built lazily and reused: a server that never gets used costs no socket,
    // and one that does is verified exactly once.
    const transports = new Map<string, {transporter: Transporter; config: SmtpConnectionConfig}>();

    async function transportFor(server: ISmtpServer) {
        const key = server._id.toString();
        const existing = transports.get(key);
        if (existing) return existing;

        const config = smtpServerToConnectionConfig(server);
        const transporter = nodemailer.createTransport({
            ...buildNodemailerOptions(config),
            pool: true,
            maxConnections: POOL_MAX_CONNECTIONS,
            maxMessages: POOL_MAX_MESSAGES,
        } as nodemailer.TransportOptions);
        await transporter.verify();

        const entry = {transporter, config};
        transports.set(key, entry);
        return entry;
    }

    return {
        async send(message: MailDeliverySendOptions): Promise<{messageId?: string}> {
            if (!EMAIL.ENABLED) {
                return {};
            }
            const mailOptions = prepare(message);

            for (const server of servers) {
                try {
                    const {transporter, config} = await transportFor(server);
                    return await sendViaTransporter(transporter, mailOptions, config);
                }
                catch (err: any) {
                    logger.warn(
                        `Pooled SMTP server ${server._id} (sequence=${server.sequence}) failed for company ${companyKey}: ${err?.message ?? err}`,
                    );
                    // A broken pool must not be reused for the next recipient.
                    const entry = transports.get(server._id.toString());
                    if (entry) {
                        try { entry.transporter.close(); } catch { /* already gone */ }
                        transports.delete(server._id.toString());
                    }
                }
            }

            return sendViaEnvFallback(mailOptions);
        },

        async close(): Promise<void> {
            for (const {transporter} of transports.values()) {
                try { transporter.close(); } catch { /* already gone */ }
            }
            transports.clear();
        },
    };
}

type SmtpTestErrorLike = {
    code?: string;
    responseCode?: number;
    message?: string;
};

function sanitizeSmtpTestDetail(message?: string): string {
    if (!message || typeof message !== "string") {
        return "";
    }
    return message.replace(/\s+/g, " ").trim().slice(0, 500);
}

function resolveSmtpTestExceptionKey(err: unknown): {key: string; detail?: string} {
    const e = (err ?? {}) as SmtpTestErrorLike;
    const code = (e.code ?? "").toUpperCase();
    const msg = (e.message ?? "").toLowerCase();
    const responseCode = e.responseCode;

    if (code === "ENOTFOUND" || msg.includes("getaddrinfo enotfound")) {
        return {key: "smtp_test_host_not_found"};
    }
    if (code === "ECONNREFUSED" || msg.includes("connection refused")) {
        return {key: "smtp_test_connection_refused"};
    }
    if (code === "ETIMEDOUT" || code === "ETIMEOUT" || msg.includes("timed out") || msg.includes("timeout")) {
        return {key: "smtp_test_connection_timeout"};
    }
    if (
        code === "EAUTH" ||
        responseCode === 535 ||
        responseCode === 534 ||
        msg.includes("authentication") ||
        msg.includes("invalid login") ||
        msg.includes("username and password not accepted")
    ) {
        return {key: "smtp_test_auth_failed"};
    }
    if (
        code === "ETLS" ||
        code === "ECERT" ||
        msg.includes("tls") ||
        msg.includes("ssl") ||
        msg.includes("certificate") ||
        msg.includes("self signed")
    ) {
        return {key: "smtp_test_tls_failed"};
    }

    const detail = sanitizeSmtpTestDetail(e.message);
    return detail ? {key: "smtp_test_failed", detail} : {key: "smtp_test_failed"};
}

function throwSmtpTestValidationError(err: unknown, languageCode: string): never {
    const lang = languageCode?.trim() || DEFAULT_EXCEPTION_LANGUAGE;
    const {key, detail} = resolveSmtpTestExceptionKey(err);
    const inserts = detail ? [detail] : [];
    throw apiValidationException(key, "", null, lang, inserts);
}

export async function testSmtpConnection(
    config: SmtpConnectionConfig,
    testRecipient: string,
    serverName?: string,
    languageCode: string = DEFAULT_EXCEPTION_LANGUAGE,
): Promise<{ok: boolean; message: string}> {
    const transporter = buildTransporter(config);
    try {
        await transporter.verify();
        const from = formatFromAddress(config.fromEmail, config.fromName);
        await transporter.sendMail({
            from,
            to: testRecipient,
            subject: `[SYSTEM] SMTP test${serverName ? ` — ${serverName}` : ""}`,
            text: "This is a test message from your system outgoing mail configuration.",
            html: "<p>This is a test message from your system outgoing mail configuration.</p>",
            replyTo: config.replyTo,
        });
        return {ok: true, message: "Connection verified and test email sent."};
    } catch (err: unknown) {
        throwSmtpTestValidationError(err, languageCode);
    }
}

import nodemailer, {type Transporter} from "nodemailer";
import type {SendMailOptions as NodemailerSendMailOptions} from "nodemailer";
import {ObjectId} from "mongodb";
import {EMAIL, SERVER} from "@coreModule/environment";
import {getLogger} from "@coreModule/loggers/serverLog";
import SmtpServer, {type ISmtpServer} from "@coreModule/database/schemas/smtpServer/smtpServer";
import User from "@coreModule/database/schemas/user/user";
import Company from "@coreModule/database/schemas/company/company";
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
        return;
    }
    companyServerCache.clear();
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

    const servers = await SmtpServer.find({
        company: new ObjectId(key),
        active: true,
        deletedAt: null,
    })
        .sort({sequence: 1, name: 1})
        .lean<ISmtpServer[]>();

    companyServerCache.set(key, {
        servers: servers as ISmtpServer[],
        expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return servers as ISmtpServer[];
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
    return {messageId: (info as any)?.messageId};
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

    const user = await User.findById(userId)
        .select("roles.company requests.invitation.company")
        .lean();

    const invitationCompany = (user as any)?.requests?.invitation?.company;
    if (invitationCompany) {
        return invitationCompany.toString();
    }

    const roleCompany = (user as any)?.roles?.[0]?.company;
    if (roleCompany) {
        return roleCompany.toString();
    }

    const defaultCompany = await Company.findOne({isDefaultForSignUp: true}).select("_id").lean();
    return defaultCompany?._id?.toString();
}

/**
 * Sends mail using company SMTP servers in sequence order, then falls back to .env EMAIL_* settings.
 */
export async function sendMail(
    companyId: ObjectId | string | undefined | null,
    mailOptions: MailDeliverySendOptions,
): Promise<void> {
    if (!EMAIL.ENABLED) {
        return;
    }

    if (!companyId) {
        await sendViaEnvFallback(mailOptions);
        return;
    }

    const companyKey = companyId.toString();
    const servers = await loadActiveServers(companyId);

    for (const server of servers) {
        try {
            const config = smtpServerToConnectionConfig(server);
            const transporter = buildTransporter(config);
            await transporter.verify();
            await sendViaTransporter(transporter, mailOptions, config);
            logger.debug(`Email sent via SMTP server ${server._id} (sequence=${server.sequence}) for company ${companyKey}`);
            return;
        } catch (err: any) {
            logger.warn(
                `SMTP server ${server._id} (sequence=${server.sequence}) failed for company ${companyKey}: ${err?.message ?? err}`,
            );
        }
    }

    try {
        await sendViaEnvFallback(mailOptions);
        logger.debug(`Email sent via environment SMTP fallback for company ${companyKey}`);
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
 * A reusable SMTP session for sending many messages to one company's servers.
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
 * It also returns the provider's message id, which `sendMail` cannot — that is
 * what lets a recipient row record exactly what was sent.
 *
 * Callers **must** `close()` (in a `finally`), or the pooled sockets stay open.
 */
export async function createPooledMailSession(
    companyId: ObjectId | string | undefined | null,
): Promise<PooledMailSession> {
    const companyKey = companyId?.toString();
    const servers = companyKey ? await loadActiveServers(companyKey) : [];

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
        async send(mailOptions: MailDeliverySendOptions): Promise<{messageId?: string}> {
            if (!EMAIL.ENABLED) {
                return {};
            }

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

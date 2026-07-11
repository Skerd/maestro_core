/**
 * Environment Configuration Module
 * 
 * Centralized configuration management for the Arpeggio-Maestro server.
 * Loads and exports all environment variables as typed configuration objects.
 * 
 * Configuration Categories:
 * - SERVER: Server settings (port, timezone, CORS, etc.)
 * - WEBSOCKET: WebSocket server configuration
 * - MONGO_DB: MongoDB connection and pool settings
 * - AUTHENTICATION: JWT, session, MFA, OAuth settings
 * - KAFKA: Kafka broker and topic configuration
 * - EMAIL: SMTP email service configuration
 * - REDIS: Redis cluster connection settings
 * - FILE_UPLOAD: File upload limits and security scanner settings
 * - TELEGRAM: Telegram bot configuration
 * - CONSTANTS: Application constants (languages, etc.)
 * - PROMETHEUS: Metrics and observability settings
 * 
 * All configuration values are loaded from environment variables via dotenv.
 * Use validateConfiguration() from validator.ts to ensure all required values are present.
 * 
 * @module environments/index
 */

import * as dotenv from 'dotenv';
import path from "path";

// Load environment variables from .env file
dotenv.config();

export const SERVER = {
    PORT: parseInt(process.env.SERVER_PORT, 10),
    NODE_ENV: process.env.SERVER_NODE_ENV,
    API_VERSION: process.env.SERVER_API_VERSION,
    CLIENT_BASE_URL: process.env.SERVER_CLIENT_BASE_URL,
    CORS_ORIGIN: process.env.SERVER_CORS_ORIGIN,
    ALLOWED_ORIGINS: process.env.SERVER_ALLOWED_ORIGINS,
    TIMEZONE: process.env.SERVER_TIMEZONE,
    NODE_SIGNATURE: process.env.SERVER_NODE_SIGNATURE,
};

export const WEBSOCKET = {
    HOST: process.env.WEBSOCKET_HOST,
    PORT: parseInt(process.env.WEBSOCKET_PORT, 10),
    RETRY_TIMER: parseInt(process.env.WEBSOCKET_RETRY_TIMER, 10),
    KEEP_ALIVE_INTERVAL: parseInt(process.env.WEBSOCKET_KEEP_ALIVE_INTERVAL, 10)
};

export const MACHINE_TO_MACHINE_SECRET = process.env.MACHINE_TO_MACHINE_SECRET;

export const MONGO_DB = {
    PRE_HOST: process.env.MONGODB_PRE_HOST,
    HOST: process.env.MONGODB_HOST,
    PORT: process.env.MONGODB_PORT,
    DB_NAME: process.env.MONGODB_DB_NAME,
    USER: process.env.MONGODB_USER,
    PASSWORD: process.env.MONGODB_PASSWORD,
    PARAMS: process.env.MONGODB_PARAMS,
    CONNECTION_TIMER: parseInt(process.env.MONGODB_CONNECTION_TIMER, 10),
    INIT: process.env.MONGODB_INIT.toLowerCase().trim() === "true",
    AUTH_SOURCE: process.env.MONGODB_AUTH_SOURCE,
    REPLICA_SET: process.env.MONGODB_REPLICA_SET,
    ROOT_CA_CERT_PATH: process.env.MONGODB_ROOT_CA_CERT_PATH,
    TLS_CERTIFICATE_KEY_FILE_PATH: process.env.MONGODB_TLS_CERTIFICATE_KEY_FILE_PATH,
    MAX_POOL_SIZE: parseInt(process.env.MONGODB_MAX_POOL_SIZE, 10),
    MIN_POOL_SIZE: parseInt(process.env.MONGODB_MIN_POOL_SIZE, 10),
    MAX_IDLE_TIME_MS: parseInt(process.env.MONGODB_MAX_IDLE_TIME_MS, 10),
    SERVER_SELECTION_TIMEOUT_MS: parseInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 10),
    SOCKET_TIMEOUT_MS: parseInt(process.env.MONGODB_SOCKET_TIMEOUT_MS, 10),
    CONNECT_TIMEOUT_MS: parseInt(process.env.MONGODB_CONNECT_TIMEOUT_MS, 10)
};

export const IP_INFO = {
    ENABLED: process.env.IP_INFO === 'true',
    TOKEN: process.env.IP_INFO_TOKEN,
}

export const AUTHENTICATION = {
    JWT_SECRET: process.env.JWT_SECRET,
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN,
    JWT_REFRESH_TOKEN_EXPIRES_IN: process.env.REFRESH_TOKEN_EXPIRES_IN,
    JWT_ISSUER: process.env.JWT_ISSUER,
    JWT_PANEL_AUDIENCE: process.env.JWT_PANEL_AUDIENCE,
    JWT_CLIENT_AUDIENCE: process.env.JWT_CLIENT_AUDIENCE,
    SALT: parseInt(process.env.SALT, 10),
    BCRYPT_ROUNDS: parseInt(process.env.BCRYPT_ROUNDS, 10),
    SESSION_SECRET: process.env.SESSION_SECRET,
    COOKIE_SECRET: process.env.COOKIE_SECRET,
    SESSION_MAX_AGE: parseInt(process.env.SESSION_MAX_AGE, 10),
    MFA_ISSUER: process.env.MFA_ISSUER,

    ACTIVATION_EMAIL_TIMEOUT: process.env.ACTIVATION_EMAIL_TIMEOUT === "true",
    ACTIVATION_EMAIL_MAX_ATTEMPTS: parseInt(process.env.ACTIVATION_EMAIL_MAX_ATTEMPTS, 10),
    ACTIVATION_EMAIL_LOCKOUT_DURATION: parseInt(process.env.ACTIVATION_EMAIL_LOCKOUT_DURATION, 10),

    SESSION_EXPIRES_IN: parseInt(process.env.SESSION_EXPIRES_IN, 10),

    ACTIVATE_LOGIN_LOCKOUT: process.env.ACTIVATE_LOGIN_TIMEOUT === "true",
    LOGIN_MAX_ATTEMPTS: parseInt(process.env.LOGIN_MAX_ATTEMPTS, 10),
    LOGIN_LOCKOUT_DURATION: parseInt(process.env.LOGIN_LOCKOUT_DURATION, 10), // 30 minutes

    ACTIVATE_MFA_TIMEOUT: process.env.ACTIVATE_MFA_TIMEOUT === "true",
    MFA_DISABLE_MAX_ATTEMPTS: parseInt(process.env.MFA_DISABLE_MAX_ATTEMPTS, 10),
    MFA_DISABLE_LOCKOUT_DURATION: parseInt(process.env.MFA_DISABLE_LOCKOUT_DURATION, 10),

    ACTIVATE_PASSWORD_RESET_TIMEOUT: process.env.ACTIVATE_PASSWORD_RESET_TIMEOUT === "true",
    PASSWORD_RESET_MAX_ATTEMPTS: parseInt(process.env.PASSWORD_RESET_MAX_ATTEMPTS, 10),
    PASSWORD_RESET_LOCKOUT_DURATION: parseInt(process.env.PASSWORD_RESET_LOCKOUT_DURATION, 10),
    PASSWORD_RESET_EXPIRE_AFTER_OPEN: process.env.PASSWORD_RESET_EXPIRE_AFTER_OPEN === "true",

    ACTIVATE_INVITATION_TIMEOUT: process.env.ACTIVATE_INVITATION_TIMEOUT === "true",
    INVITATION_MAX_ATTEMPTS: parseInt(process.env.INVITATION_MAX_ATTEMPTS, 10),
    INVITATION_LOCKOUT_DURATION: parseInt(process.env.INVITATION_LOCKOUT_DURATION, 10),

    ACTIVATE_GOOGLE_LOGIN: process.env.ACTIVATE_GOOGLE_LOGIN === "true",
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URL: process.env.GOOGLE_REDIRECT_URL,

    ACTIVATE_APPLE_LOGIN: process.env.ACTIVATE_APPLE_LOGIN === "true",
    APPLE_KEY_ID: process.env.APPLE_KEY_ID,
    APPLE_CLIENT_ID: process.env.APPLE_CLIENT_ID,
    APPLE_TEAM_ID: process.env.APPLE_TEAM_ID,
    APPLE_CLIENT_SECRET: process.env.APPLE_CLIENT_SECRET,
    APPLE_REDIRECT_URL: process.env.APPLE_REDIRECT_URL,
    APPLE_PRIVATE_KEY_PATH: process.env.APPLE_PRIVATE_KEY_PATH,
};

export const CONSTANTS = {
    DEFAULT_LANGUAGE: process.env.DEFAULT_LANGUAGE,
    SUPPORTED_LANGUAGES: process.env.SUPPORTED_LANGUAGES.split(",")
};

export const TELEGRAM = {
    NAME: process.env.TELEGRAM_NAME,
    TOKEN: process.env.TELEGRAM_TOKEN
}

export type KafkaSecurityProtocol = 'PLAINTEXT' | 'SSL' | 'SASL_PLAINTEXT' | 'SASL_SSL';
export type KafkaSaslMechanism = 'plain' | 'scram-sha-256' | 'scram-sha-512';

export const KAFKA = {
    ENABLED: process.env.KAFKA_ENABLED === 'true',
    BROKERS: process.env.KAFKA_BROKERS.split(","),
    CLIENT_ID: process.env.KAFKA_CLIENT_ID,
    CONNECTION_TIMER: parseInt(process.env.KAFKA_CONNECTION_TIMER, 10),
    CONSUMER_MAX_RETRIES: parseInt(process.env.KAFKA_CONSUMER_MAX_RETRIES, 10),
    PRODUCER_MAX_RETRIES: parseInt(process.env.KAFKA_PRODUCER_MAX_RETRIES, 10),
    PRODUCER_RETRY_DELAY_BASE_MS: parseInt(process.env.KAFKA_PRODUCER_RETRY_DELAY_BASE_MS, 10),
    SECURITY_PROTOCOL: (process.env.KAFKA_SECURITY_PROTOCOL || 'PLAINTEXT') as KafkaSecurityProtocol,
    SASL_MECHANISM: (process.env.KAFKA_SASL_MECHANISM || 'plain').toLowerCase() as KafkaSaslMechanism,
    USERNAME: process.env.KAFKA_USERNAME || '',
    PASSWORD: process.env.KAFKA_PASSWORD || '',
    SSL_CA_PATH: process.env.KAFKA_SSL_CA_PATH || '',
    SSL_REJECT_UNAUTHORIZED: process.env.KAFKA_SSL_REJECT_UNAUTHORIZED === 'true',

    TOPICS: {
        USER_LOGIN_HISTORY: process.env.KAFKA_TOPIC_USER_LOGIN_HISTORY,
        ACTIVATION_EMAIL: process.env.KAFKA_TOPIC_ACTIVATION_EMAIL,
        MFA_DISABLE_EMAIL: process.env.KAFKA_TOPIC_MFA_DISABLE_EMAIL,
        FORGOT_PASSWORD_EMAIL: process.env.KAFKA_TOPIC_FORGOT_PASSWORD_EMAIL,
        INVITATION_EMAIL: process.env.KAFKA_TOPIC_INVITATION_EMAIL,
        RESERVATION_CLIENT_EMAIL: process.env.KAFKA_TOPIC_RESERVATION_CLIENT_EMAIL,
        SALE_CLIENT_EMAIL: process.env.KAFKA_TOPIC_SALE_CLIENT_EMAIL,
        API_ACCESS: process.env.KAFKA_TOPIC_API_ACCESS,
        CRON_EXECUTE: process.env.KAFKA_TOPIC_CRON_EXECUTE,
        AI_CHANNEL_MESSAGE: process.env.KAFKA_TOPIC_AI_CHANNEL_MESSAGE,
    },
    CONSUMER_GROUP: {
        LOGIN_HISTORY: process.env.KAFKA_CONSUMER_GROUP_LOGIN_HISTORY,
        ACTIVATION_EMAIL: process.env.KAFKA_CONSUMER_GROUP_ACTIVATION_EMAIL,
        MFA_DISABLE_EMAIL: process.env.KAFKA_CONSUMER_GROUP_MFA_DISABLE_EMAIL,
        FORGOT_PASSWORD_EMAIL: process.env.KAFKA_CONSUMER_GROUP_FORGOT_PASSWORD_EMAIL,
        INVITATION_EMAIL: process.env.KAFKA_CONSUMER_GROUP_INVITATION_EMAIL,
        RESERVATION_CLIENT_EMAIL: process.env.KAFKA_CONSUMER_GROUP_RESERVATION_CLIENT_EMAIL,
        SALE_CLIENT_EMAIL: process.env.KAFKA_CONSUMER_GROUP_SALE_CLIENT_EMAIL,
        API_ACCESS: process.env.KAFKA_CONSUMER_GROUP_API_ACCESS,
        CRON_EXECUTE: process.env.KAFKA_CONSUMER_GROUP_CRON_EXECUTE,
        AI_CHANNEL_MESSAGE: process.env.KAFKA_CONSUMER_GROUP_AI_CHANNEL_MESSAGE,
    },
};

export const EMAIL = {
    ENABLED: process.env.EMAIL_ENABLED === 'true',
    PROVIDER: process.env.EMAIL_PROVIDER,
    SMTP_HOST: process.env.EMAIL_HOST,
    SMTP_PORT: parseInt(process.env.EMAIL_PORT, 10),
    SMTP_SECURE: process.env.EMAIL_SECURE === 'true',
    SMTP_USER: process.env.EMAIL_USER,
    SMTP_PASSWORD: process.env.EMAIL_PASS,
    FROM_EMAIL: process.env.EMAIL_FROM,
    FROM_NAME: process.env.EMAIL_FROM_NAME,
    TEMPLATE_DIR: process.env.EMAIL_TEMPLATE_DIR || path.join(__dirname, '../templates/email'),
    REPLY_TO_EMAIL: process.env.REPLY_TO_EMAIL
};

export const CLIENT_SIDE = {
    HOST: process.env.CLIENT_HOST,
    NAME: process.env.CLIENT_NAME
}

export const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

export const REDIS = {
    ROOT_NODES: process.env.REDIS_ROOT_NODES.split(","),
    USERNAME: process.env.REDIS_USERNAME,
    PASSWORD: process.env.REDIS_PASSWORD,
    DATABASE: process.env.REDIS_DATABASE,
    KEY_PREFIX: process.env.REDIS_KEY_PREFIX,
    CONNECT_TIMEOUT: parseInt(process.env.REDIS_CONNECT_TIMEOUT, 10),
    CONNECTION_TIMER: parseInt(process.env.REDIS_CONNECTION_TIMER, 10),
}

export const METRICS = {
    DURATION_WINDOW_MS: parseInt(process.env.METRICS_DURATION_WINDOW_MS || "3600000", 10)
}

export const FILE_UPLOAD = {
    MAX_FILES_UPLOADED: parseInt(process.env.MAX_FILES_UPLOADED, 10),
    MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE, 10),
    FILE_SCANNER_TYPE: process.env.FILE_SCANNER_TYPE,
    MOCK_SCANNER_SIMULATE_THREATS: process.env.MOCK_SCANNER_SIMULATE_THREATS === 'true',
    CLAMAV_HOST: process.env.CLAMAV_HOST,
    CLAMAV_PORT: parseInt(process.env.CLAMAV_PORT, 10),
    VIRUSTOTAL_API_KEY:process.env.VIRUSTOTAL_API_KEY
}

export const CHAT = {
    ENABLE_RECOVERY: process.env.ENABLE_RECOVERY === 'true'
}

export const PROMETHEUS = {
    ENABLED: process.env.PROMETHEUS_ENABLED === 'true',
    HOST: process.env.PROMETHEUS_HOST || 'localhost',
    PORT: parseInt(process.env.PROMETHEUS_PORT || '9090', 10),
    SCRAPE_INTERVAL: process.env.PROMETHEUS_SCRAPE_INTERVAL || '15s',
    METRICS_PATH: process.env.PROMETHEUS_METRICS_PATH || '/auxiliary/metrics'
}

export const REQUEST_VALIDATION = {
    MAX_ARRAY_SIZE: parseInt(process.env.REQUEST_MAX_ARRAY_SIZE, 10),
    MAX_DEPTH: parseInt(process.env.REQUEST_MAX_DEPTH, 10),
    MAX_STRING_LENGTH: parseInt(process.env.REQUEST_MAX_STRING_LENGTH, 10)
}

export const CRON = {
    ENABLED: process.env.CRON_ENABLED !== "false",
    SCHEDULER_TICK_MS: parseInt(process.env.CRON_SCHEDULER_TICK_MS || "1000", 10),
    SCHEDULER_BATCH_SIZE: parseInt(process.env.CRON_SCHEDULER_BATCH_SIZE || "50", 10),
    LEADER_LOCK_TTL_MS: parseInt(process.env.CRON_LEADER_LOCK_TTL_MS || "15000", 10),
    LOCK_TTL_MS: parseInt(process.env.CRON_LOCK_TTL_MS || "120000", 10),
    MAX_CONCURRENT_GLOBAL: parseInt(process.env.CRON_MAX_CONCURRENT_GLOBAL || "50", 10),
    MAX_CONCURRENT_PER_COMPANY: parseInt(process.env.CRON_MAX_CONCURRENT_PER_COMPANY || "10", 10),
    EXECUTION_RETENTION_DAYS: parseInt(process.env.CRON_EXECUTION_RETENTION_DAYS || "90", 10),
    SELF_HEAL_INTERVAL_MS: parseInt(process.env.CRON_SELF_HEAL_INTERVAL_MS || "300000", 10),
    GRACEFUL_SHUTDOWN_MS: parseInt(process.env.CRON_GRACEFUL_SHUTDOWN_MS || "30000", 10),
    SEED_PLATFORM_JOBS: process.env.CRON_SEED_PLATFORM_JOBS === "true",
    SERVER_ID: process.env.CRON_SERVER_ID || `${process.env.HOSTNAME || "host"}:${process.pid}`,
    TOPIC_EXECUTE: process.env.KAFKA_TOPIC_CRON_EXECUTE || "cron.execute",
    CONSUMER_GROUP_EXECUTE: process.env.KAFKA_CONSUMER_GROUP_CRON_EXECUTE || "CRON_WORKERS",
};
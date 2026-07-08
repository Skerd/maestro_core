/**
 * Configuration Validator
 * 
 * Validates all environment variables on startup.
 * Fails fast with clear error messages if configuration is invalid.
 */

interface ValidationError {
    key: string;
    message: string;
}

/**
 * Validate that a string environment variable exists
 */
function validateString(key: string, value: string | undefined, required: boolean = true): ValidationError | null {
    if (required && (!value || value.trim() === '')) {
        return {key, message: `Required environment variable ${key} is missing or empty`};
    }
    return null;
}

/**
 * Validate that a number environment variable exists and is valid
 */
function validateNumber(key: string, value: string | undefined, required: boolean = true, min?: number, max?: number): ValidationError | null {
    if (required && (!value || value.trim() === '')) {
        return {key, message: `Required environment variable ${key} is missing or empty`};
    }

    if (value) {
        const num = parseInt(value, 10);
        if (isNaN(num)) {
            return {key, message: `Environment variable ${key} must be a valid number, got: ${value}`};
        }

        if (min !== undefined && num < min) {
            return {key, message: `Environment variable ${key} must be at least ${min}, got: ${num}`};
        }

        if (max !== undefined && num > max) {
            return {key, message: `Environment variable ${key} must be at most ${max}, got: ${num}`};
        }
    }

    return null;
}

/**
 * Validate that a boolean environment variable exists
 */
function validateBoolean(key: string, value: string | undefined, required: boolean = true): ValidationError | null {
    if (required && (!value || value.trim() === '')) {
        return {key, message: `Required environment variable ${key} is missing or empty`};
    }

    if (value && value.toLowerCase() !== 'true' && value.toLowerCase() !== 'false') {
        return {key, message: `Environment variable ${key} must be 'true' or 'false', got: ${value}`};
    }

    return null;
}

/**
 * Validate that an array (comma-separated) environment variable exists
 */
function validateArray(key: string, value: string | undefined, required: boolean = true, minLength: number = 1): ValidationError | null {
    if (required && (!value || value.trim() === '')) {
        return {key, message: `Required environment variable ${key} is missing or empty`};
    }

    if (value) {
        const items = value.split(',').map(item => item.trim()).filter(item => item !== '');
        if (items.length < minLength) {
            return {key, message: `Environment variable ${key} must have at least ${minLength} item(s), got: ${items.length}`};
        }
    }

    return null;
}

/**
 * Validate all environment variables
 * 
 * @throws Error if validation fails
 */
export function validateConfiguration(): void {
    const errors: ValidationError[] = [];

    // SERVER CONFIGURATION
    errors.push(...[
        validateNumber('SERVER_PORT', process.env.SERVER_PORT, true, 1, 65535),
        validateString('SERVER_NODE_ENV', process.env.SERVER_NODE_ENV, true),
        validateString('SERVER_API_VERSION', process.env.SERVER_API_VERSION, false),
        validateString('SERVER_CLIENT_BASE_URL', process.env.SERVER_CLIENT_BASE_URL, false),
        validateString('SERVER_CORS_ORIGIN', process.env.SERVER_CORS_ORIGIN, false),
        validateArray('SERVER_ALLOWED_ORIGINS', process.env.SERVER_ALLOWED_ORIGINS, false, 1),
        validateString('SERVER_TIMEZONE', process.env.SERVER_TIMEZONE, true),
    ].filter((e): e is ValidationError => e !== null));

    // WEBSOCKET CONFIGURATION
    errors.push(...[
        validateString('WEBSOCKET_HOST', process.env.WEBSOCKET_HOST, true),
        validateNumber('WEBSOCKET_PORT', process.env.WEBSOCKET_PORT, true, 1, 65535),
        validateNumber('WEBSOCKET_RETRY_TIMER', process.env.WEBSOCKET_RETRY_TIMER, true, 1000),
    ].filter((e): e is ValidationError => e !== null));

    // M2M CONFIGURATION
    errors.push(...[
        validateString('MACHINE_TO_MACHINE_SECRET', process.env.MACHINE_TO_MACHINE_SECRET, true),
    ].filter((e): e is ValidationError => e !== null));

    // DATABASE CONFIGURATION
    errors.push(...[
        validateString('MONGODB_PRE_HOST', process.env.MONGODB_PRE_HOST, true),
        validateString('MONGODB_HOST', process.env.MONGODB_HOST, true),
        validateNumber('MONGODB_PORT', process.env.MONGODB_PORT, true, 1, 65535),
        validateString('MONGODB_DB_NAME', process.env.MONGODB_DB_NAME, true),
        validateString('MONGODB_USER', process.env.MONGODB_USER, true),
        validateString('MONGODB_PASSWORD', process.env.MONGODB_PASSWORD, true),
        validateString('MONGODB_PARAMS', process.env.MONGODB_PARAMS, false),
        validateString('MONGODB_ROOT_CA_CERT_PATH', process.env.MONGODB_ROOT_CA_CERT_PATH, false),
        validateString('MONGODB_TLS_CERTIFICATE_KEY_FILE_PATH', process.env.MONGODB_TLS_CERTIFICATE_KEY_FILE_PATH, false),
        validateNumber('MONGODB_CONNECTION_TIMER', process.env.MONGODB_CONNECTION_TIMER, true, 1000),
        validateBoolean('MONGODB_INIT', process.env.MONGODB_INIT, true),
        validateString('MONGODB_AUTH_SOURCE', process.env.MONGODB_AUTH_SOURCE, false),
        validateString('MONGODB_REPLICA_SET', process.env.MONGODB_REPLICA_SET, false),
        validateNumber('MONGODB_MAX_POOL_SIZE', process.env.MONGODB_MAX_POOL_SIZE, true, 1),
        validateNumber('MONGODB_MIN_POOL_SIZE', process.env.MONGODB_MIN_POOL_SIZE, true, 1),
        validateNumber('MONGODB_MAX_IDLE_TIME_MS', process.env.MONGODB_MAX_IDLE_TIME_MS, true, 1),
        validateNumber('MONGODB_SERVER_SELECTION_TIMEOUT_MS', process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, true, 1),
        validateNumber('MONGODB_SOCKET_TIMEOUT_MS', process.env.MONGODB_SOCKET_TIMEOUT_MS, true, 1),
        validateNumber('MONGODB_CONNECT_TIMEOUT_MS', process.env.MONGODB_CONNECT_TIMEOUT_MS, true, 1),

    ].filter((e): e is ValidationError => e !== null));

    // Kafka configuration (if enabled)
    if (process.env.KAFKA_ENABLED === 'true') {
        errors.push(...[
            validateArray('KAFKA_BROKERS', process.env.KAFKA_BROKERS, true, 1),
            validateString('KAFKA_CLIENT_ID', process.env.KAFKA_CLIENT_ID, true),
            validateNumber('KAFKA_CONNECTION_TIMER', process.env.KAFKA_CONNECTION_TIMER, true, 1000),
            validateNumber('KAFKA_CONSUMER_MAX_RETRIES', process.env.KAFKA_CONSUMER_MAX_RETRIES, true, 0),
            validateNumber('KAFKA_PRODUCER_MAX_RETRIES', process.env.KAFKA_PRODUCER_MAX_RETRIES, true, 0),
            validateNumber('KAFKA_PRODUCER_RETRY_DELAY_BASE_MS', process.env.KAFKA_PRODUCER_RETRY_DELAY_BASE_MS, true, 100),

            validateString('KAFKA_TOPIC_USER_LOGIN_HISTORY', process.env.KAFKA_TOPIC_USER_LOGIN_HISTORY, true),
            validateString('KAFKA_TOPIC_ACTIVATION_EMAIL', process.env.KAFKA_TOPIC_ACTIVATION_EMAIL, true),
            validateString('KAFKA_TOPIC_MFA_DISABLE_EMAIL', process.env.KAFKA_TOPIC_MFA_DISABLE_EMAIL, true),
            validateString('KAFKA_TOPIC_FORGOT_PASSWORD_EMAIL', process.env.KAFKA_TOPIC_FORGOT_PASSWORD_EMAIL, true),
            validateString('KAFKA_TOPIC_INVITATION_EMAIL', process.env.KAFKA_TOPIC_INVITATION_EMAIL, true),
            validateString('KAFKA_TOPIC_RESERVATION_CLIENT_EMAIL', process.env.KAFKA_TOPIC_RESERVATION_CLIENT_EMAIL, true),
            validateString('KAFKA_TOPIC_SALE_CLIENT_EMAIL', process.env.KAFKA_TOPIC_SALE_CLIENT_EMAIL, true),
            validateString('KAFKA_TOPIC_API_ACCESS', process.env.KAFKA_TOPIC_API_ACCESS, true),
            validateString('KAFKA_CONSUMER_GROUP_LOGIN_HISTORY', process.env.KAFKA_CONSUMER_GROUP_LOGIN_HISTORY, true),
            validateString('KAFKA_CONSUMER_GROUP_ACTIVATION_EMAIL', process.env.KAFKA_CONSUMER_GROUP_ACTIVATION_EMAIL, true),
            validateString('KAFKA_CONSUMER_GROUP_MFA_DISABLE_EMAIL', process.env.KAFKA_CONSUMER_GROUP_MFA_DISABLE_EMAIL, true),
            validateString('KAFKA_CONSUMER_GROUP_FORGOT_PASSWORD_EMAIL', process.env.KAFKA_CONSUMER_GROUP_FORGOT_PASSWORD_EMAIL, true),
            validateString('KAFKA_CONSUMER_GROUP_INVITATION_EMAIL', process.env.KAFKA_CONSUMER_GROUP_INVITATION_EMAIL, true),
            validateString('KAFKA_CONSUMER_GROUP_RESERVATION_CLIENT_EMAIL', process.env.KAFKA_CONSUMER_GROUP_RESERVATION_CLIENT_EMAIL, true),
            validateString('KAFKA_CONSUMER_GROUP_SALE_CLIENT_EMAIL', process.env.KAFKA_CONSUMER_GROUP_SALE_CLIENT_EMAIL, true),
            validateString('KAFKA_CONSUMER_GROUP_API_ACCESS', process.env.KAFKA_CONSUMER_GROUP_API_ACCESS, true),
        ].filter((e): e is ValidationError => e !== null));
    }

    // AUTHENTICATION & SECURITY
    errors.push(...[
        validateString('JWT_SECRET', process.env.JWT_SECRET, true),
        validateString('JWT_EXPIRES_IN', process.env.JWT_EXPIRES_IN, true),
        validateString('REFRESH_TOKEN_EXPIRES_IN', process.env.REFRESH_TOKEN_EXPIRES_IN, true),
        validateString('JWT_ISSUER', process.env.JWT_ISSUER, true),
        validateString('JWT_PANEL_AUDIENCE', process.env.JWT_PANEL_AUDIENCE, true),
        validateString('JWT_CLIENT_AUDIENCE', process.env.JWT_CLIENT_AUDIENCE, true),
        validateNumber('SALT', process.env.SALT, true, 1),
        validateNumber('BCRYPT_ROUNDS', process.env.BCRYPT_ROUNDS, true, 1, 20),
        validateString('SESSION_SECRET', process.env.SESSION_SECRET, true),
        validateString('COOKIE_SECRET', process.env.COOKIE_SECRET, true),
        validateNumber('SESSION_MAX_AGE', process.env.SESSION_MAX_AGE, true, 1),
        validateString('MFA_ISSUER', process.env.MFA_ISSUER, true),
        validateNumber('SESSION_EXPIRES_IN', process.env.SESSION_EXPIRES_IN, true, 1),
    ].filter((e): e is ValidationError => e !== null));

    if( process.env.ACTIVATION_EMAIL_TIMEOUT === 'true' ){
        errors.push(...[
            validateBoolean('ACTIVATION_EMAIL_TIMEOUT', process.env.ACTIVATION_EMAIL_TIMEOUT, true),
            validateNumber('ACTIVATION_EMAIL_MAX_ATTEMPTS', process.env.ACTIVATION_EMAIL_MAX_ATTEMPTS, true, 1),
            validateNumber('ACTIVATION_EMAIL_LOCKOUT_DURATION', process.env.ACTIVATION_EMAIL_LOCKOUT_DURATION, true, 1),
        ].filter((e): e is ValidationError => e !== null));
    }
    if( process.env.ACTIVATE_LOGIN_TIMEOUT === 'true' ){
        errors.push(...[
            validateBoolean('ACTIVATE_LOGIN_TIMEOUT', process.env.ACTIVATE_LOGIN_TIMEOUT, true),
            validateNumber('LOGIN_MAX_ATTEMPTS', process.env.LOGIN_MAX_ATTEMPTS, true, 1),
            validateNumber('LOGIN_LOCKOUT_DURATION', process.env.LOGIN_LOCKOUT_DURATION, true, 1),
        ].filter((e): e is ValidationError => e !== null));
    }
    if( process.env.ACTIVATE_MFA_TIMEOUT === 'true' ) {
        errors.push(...[
            validateBoolean('ACTIVATE_MFA_TIMEOUT', process.env.ACTIVATE_MFA_TIMEOUT, true),
            validateNumber('MFA_DISABLE_MAX_ATTEMPTS', process.env.MFA_DISABLE_MAX_ATTEMPTS, true, 1),
            validateNumber('MFA_DISABLE_LOCKOUT_DURATION', process.env.MFA_DISABLE_LOCKOUT_DURATION, true, 1),
        ].filter((e): e is ValidationError => e !== null));
    }
    if( process.env.ACTIVATE_PASSWORD_RESET_TIMEOUT === 'true' ){
        errors.push(...[
            validateBoolean('ACTIVATE_PASSWORD_RESET_TIMEOUT', process.env.ACTIVATE_PASSWORD_RESET_TIMEOUT, true),
            validateNumber('PASSWORD_RESET_MAX_ATTEMPTS', process.env.PASSWORD_RESET_MAX_ATTEMPTS, true, 1),
            validateNumber('PASSWORD_RESET_LOCKOUT_DURATION', process.env.PASSWORD_RESET_LOCKOUT_DURATION, true, 1),
            validateBoolean('PASSWORD_RESET_EXPIRE_AFTER_OPEN', process.env.PASSWORD_RESET_EXPIRE_AFTER_OPEN, true),
        ].filter((e): e is ValidationError => e !== null));
    }
    if( process.env.ACTIVATE_INVITATION_TIMEOUT === 'true' ){
        errors.push(...[
            validateBoolean('ACTIVATE_INVITATION_TIMEOUT', process.env.ACTIVATE_INVITATION_TIMEOUT, true),
            validateNumber('INVITATION_MAX_ATTEMPTS', process.env.INVITATION_MAX_ATTEMPTS, true, 1),
            validateNumber('INVITATION_LOCKOUT_DURATION', process.env.INVITATION_LOCKOUT_DURATION, true, 1),
        ].filter((e): e is ValidationError => e !== null));
    }
    if( process.env.IP_INFO === 'true' ){
        errors.push(...[
            validateBoolean('IP_INFO', process.env.IP_INFO, true),
            validateString('IP_INFO_TOKEN', process.env.IP_INFO_TOKEN, false),
        ].filter((e): e is ValidationError => e !== null));
    }
    if (process.env.ACTIVATE_GOOGLE_LOGIN === 'true') {
        errors.push(...[
            validateString('GOOGLE_CLIENT_ID', process.env.GOOGLE_CLIENT_ID, true),
            validateString('GOOGLE_CLIENT_SECRET', process.env.GOOGLE_CLIENT_SECRET, true),
            validateString('GOOGLE_REDIRECT_URL', process.env.GOOGLE_REDIRECT_URL, true),
        ].filter((e): e is ValidationError => e !== null));
    }
    if (process.env.ACTIVATE_APPLE_LOGIN === 'true') {
        errors.push(...[
            validateString('APPLE_KEY_ID', process.env.APPLE_KEY_ID, true),
            validateString('APPLE_CLIENT_ID', process.env.APPLE_CLIENT_ID, true),
            validateString('APPLE_TEAM_ID', process.env.APPLE_TEAM_ID, true),
            validateString('APPLE_REDIRECT_URL', process.env.APPLE_REDIRECT_URL, true),
            validateString('APPLE_PRIVATE_KEY_PATH', process.env.APPLE_PRIVATE_KEY_PATH, true),
        ].filter((e): e is ValidationError => e !== null));
    }

    // TELEGRAM
    errors.push(...[
        validateString('TELEGRAM_NAME', process.env.TELEGRAM_NAME, true),
        validateString('TELEGRAM_TOKEN', process.env.TELEGRAM_TOKEN, true),
    ].filter((e): e is ValidationError => e !== null));

    // CONSTANTS
    errors.push(...[
        validateString('DEFAULT_LANGUAGE', process.env.DEFAULT_LANGUAGE, true),
        validateArray('SUPPORTED_LANGUAGES', process.env.SUPPORTED_LANGUAGES, true, 1),
    ].filter((e): e is ValidationError => e !== null));

    // EMAIL CONFIGURATION
    if (process.env.EMAIL_ENABLED === 'true') {
        errors.push(...[
            validateString('EMAIL_PROVIDER', process.env.EMAIL_PROVIDER, true),
            validateString('EMAIL_HOST', process.env.EMAIL_HOST, true),
            validateNumber('EMAIL_PORT', process.env.EMAIL_PORT, true, 1, 65535),
            validateBoolean('EMAIL_SECURE', process.env.EMAIL_SECURE, true),
            validateString('EMAIL_USER', process.env.EMAIL_USER, true),
            validateString('EMAIL_PASS', process.env.EMAIL_PASS, true),
            validateString('EMAIL_FROM', process.env.EMAIL_FROM, true),
            validateString('EMAIL_FROM_NAME', process.env.EMAIL_FROM_NAME, true),
            validateString('EMAIL_REPLY_TO', process.env.EMAIL_REPLY_TO, false),
        ].filter((e): e is ValidationError => e !== null));
    }

    // CLIENT SIDE CONFIG
    errors.push(...[
        validateString('CLIENT_HOST', process.env.CLIENT_HOST, true),
        validateString('CLIENT_NAME', process.env.CLIENT_NAME, true),
    ].filter((e): e is ValidationError => e !== null));

    // ENCRYPTION
    errors.push(...[
        validateString('ENCRYPTION_KEY', process.env.ENCRYPTION_KEY, true),
    ].filter((e): e is ValidationError => e !== null));

    // REDIS
    errors.push(...[
        validateArray('REDIS_ROOT_NODES', process.env.REDIS_ROOT_NODES, true, 1),
        validateString('REDIS_USERNAME', process.env.REDIS_USERNAME, false),
        validateString('REDIS_PASSWORD', process.env.REDIS_PASSWORD, false),
        validateNumber('REDIS_DATABASE', process.env.REDIS_DATABASE, false, 0),
        validateString('REDIS_KEY_PREFIX', process.env.REDIS_KEY_PREFIX, false),
        validateNumber('REDIS_CONNECT_TIMEOUT', process.env.REDIS_CONNECT_TIMEOUT, true, 1000),
        validateNumber('REDIS_CONNECTION_TIMER', process.env.REDIS_CONNECTION_TIMER, true, 1000),
    ].filter((e): e is ValidationError => e !== null));

    // FILE UPLOAD SECURITY
    errors.push(...[
        validateNumber('MAX_FILES_UPLOADED', process.env.MAX_FILES_UPLOADED, true, 1),
        validateNumber('MAX_FILE_SIZE', process.env.MAX_FILE_SIZE, true, 1),
        validateString('FILE_SCANNER_TYPE', process.env.FILE_SCANNER_TYPE, true),
        validateBoolean('MOCK_SCANNER_SIMULATE_THREATS', process.env.MOCK_SCANNER_SIMULATE_THREATS, true),
    ].filter((e): e is ValidationError => e !== null));

    if (process.env.FILE_SCANNER_TYPE === 'clamav') {
        errors.push(...[
            validateString('CLAMAV_HOST', process.env.CLAMAV_HOST, true),
            validateNumber('CLAMAV_PORT', process.env.CLAMAV_PORT, true, 1, 65535),
        ].filter((e): e is ValidationError => e !== null));
    }
    if (process.env.FILE_SCANNER_TYPE === 'virustotal') {
        errors.push(...[
            validateString('VIRUSTOTAL_API_KEY', process.env.VIRUSTOTAL_API_KEY, true),
        ].filter((e): e is ValidationError => e !== null));
    }

    // CHAT SECURITY
    errors.push(...[
        validateBoolean('ENABLE_RECOVERY', process.env.ENABLE_RECOVERY, true),
    ].filter((e): e is ValidationError => e !== null));

    // PROMETHEUS CONFIGURATION (optional)
    if (process.env.PROMETHEUS_ENABLED === 'true') {
        errors.push(...[
            validateBoolean('PROMETHEUS_ENABLED', process.env.PROMETHEUS_ENABLED, true),
            validateString('PROMETHEUS_HOST', process.env.PROMETHEUS_HOST, false),
            validateNumber('PROMETHEUS_PORT', process.env.PROMETHEUS_PORT, false, 1, 65535),
            validateString('PROMETHEUS_SCRAPE_INTERVAL', process.env.PROMETHEUS_SCRAPE_INTERVAL, false),
            validateString('PROMETHEUS_METRICS_PATH', process.env.PROMETHEUS_METRICS_PATH, false),
        ].filter((e): e is ValidationError => e !== null));
    }

    if (errors.length > 0) {
        const errorMessages = errors.map(e => `  - ${e.key}: ${e.message}`).join('\n');
        throw new Error(
            `Configuration validation failed:\n${errorMessages}\n\n` +
            `Please check your .env file and ensure all required environment variables are set correctly.`
        );
    }

    errors.push(...[
        validateNumber('REQUEST_MAX_ARRAY_SIZE', process.env.REQUEST_MAX_ARRAY_SIZE, false, 1, 1000),
        validateNumber('REQUEST_MAX_DEPTH', process.env.REQUEST_MAX_DEPTH, false, 1, 10),
        validateNumber('REQUEST_MAX_STRING_LENGTH', process.env.REQUEST_MAX_STRING_LENGTH, false, 1, 200000),
    ].filter((e): e is ValidationError => e !== null));

}


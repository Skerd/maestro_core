/**
 * Encryption Utilities
 * 
 * Provides secure encryption/decryption using Node.js built-in crypto module.
 * Uses AES-256-CBC with random IV for each encryption operation.
 */

import crypto from "crypto";
import {ENCRYPTION_KEY} from "@coreModule/environment";

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16; // 16 bytes for AES
const IV_HEX_LENGTH = IV_LENGTH * 2;
const ENCRYPTED_PAYLOAD = new RegExp(`^[0-9a-f]{${IV_HEX_LENGTH}}:[0-9a-f]+$`, "i");

function requireEncryptionKey(): string {
    if (!ENCRYPTION_KEY) {
        throw new Error("ENCRYPTION_KEY is not configured");
    }
    return ENCRYPTION_KEY;
}

function looksLikeEncryptedPayload(value: string): boolean {
    return ENCRYPTED_PAYLOAD.test(value);
}

/**
 * Encrypt a string using AES-256-CBC
 * 
 * @param text - Plain text to encrypt
 * @returns Encrypted string in format: IV:encryptedData (both hex encoded)
 * @throws Error if encryption key is not configured
 */
export function EncryptString(text: string): string {
    const encryptionKey = requireEncryptionKey();

    const iv = crypto.randomBytes(IV_LENGTH);
    const key = crypto.createHash('sha256').update(encryptionKey).digest();
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt a string encrypted with EncryptString
 * 
 * @param encryptedText - Encrypted string in format: IV:encryptedData
 * @returns Decrypted plain text
 * @throws Error if decryption fails
 */
export function DecryptString(encryptedText: string): string {
    const encryptionKey = requireEncryptionKey();

    try {
        const parts = encryptedText.split(':');
        if (parts.length !== 2) {
            throw new Error("Invalid encrypted text format. Expected IV:encryptedData");
        }

        const iv = Buffer.from(parts[0], 'hex');
        if (iv.length !== IV_LENGTH) {
            throw new Error("Invalid initialization vector");
        }

        const encrypted = parts[1];
        const key = crypto.createHash('sha256').update(encryptionKey).digest();
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    } catch (error: any) {
        throw new Error(`Decryption failed: ${error.message}`);
    }
}

/**
 * Decrypt a stored field that should be ciphertext, without throwing.
 *
 * Legacy plaintext (anything that is not `IV:hex`) is returned as-is so
 * pre-encryption rows cannot take down DTO mapping. Ciphertext that fails
 * to decrypt is treated as unreadable and returns "".
 */
export function DecryptStringSafe(encryptedText: string | null | undefined): string {
    if (!encryptedText) {
        return "";
    }

    try {
        return DecryptString(encryptedText);
    } catch {
        return looksLikeEncryptedPayload(encryptedText) ? "" : encryptedText;
    }
}

/**
 * Validate encryption key format
 */
export function validateEncryptionKey(): boolean {
    return ENCRYPTION_KEY ? ENCRYPTION_KEY.length >= 16 : false;
}

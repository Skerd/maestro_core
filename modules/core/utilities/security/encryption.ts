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

/**
 * Encrypt a string using AES-256-CBC
 * 
 * @param text - Plain text to encrypt
 * @returns Encrypted string in format: IV:encryptedData (both hex encoded)
 * @throws Error if encryption key is not configured
 */
export function EncryptString(text: string): string {
    if (!ENCRYPTION_KEY) {
        throw new Error("ENCRYPTION_KEY is not configured");
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
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
    if (!ENCRYPTION_KEY) {
        throw new Error("ENCRYPTION_KEY is not configured");
    }

    try {
        const parts = encryptedText.split(':');
        if (parts.length !== 2) {
            throw new Error("Invalid encrypted text format. Expected IV:encryptedData");
        }

        const iv = Buffer.from(parts[0], 'hex');
        const encrypted = parts[1];
        const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    } catch (error: any) {
        throw new Error(`Decryption failed: ${error.message}`);
    }
}

/**
 * Validate encryption key format
 */
export function validateEncryptionKey(): boolean {
    return ENCRYPTION_KEY ? ENCRYPTION_KEY.length >= 16 : false;
}


/**
 * File Security Scanner
 *
 * Pluggable malware scanning for uploaded files: ClamAV (clamd over TCP), or a mock for development and tests.
 */

import {getLogger, serverLogger} from '@coreModule/loggers/serverLog';
import fs from 'fs';
import net from 'net';
import {FILE_UPLOAD} from "@coreModule/environment";

export interface ScanResult {
    safe: boolean;
    scanned: boolean;
    result?: string;
    /** The signature found, when a scan found a threat. */
    threat?: string;
    error?: string;
    scanner?: string;
}

export interface FileScanner {
    scanFile(filePath: string, buffer?: Buffer): Promise<ScanResult>;
    isAvailable(): boolean;
    getName(): string;
}

/**
 * Mock Scanner - For development/testing.
 * It scans nothing, so a file it lets through is recorded as not scanned (`safeCheckedFlag` stays false).
 * With `simulateThreats`, a file whose name or content contains "malicious" is refused.
 */
export class MockFileScanner implements FileScanner {
    private logger: serverLogger;
    private simulateThreats: boolean;

    constructor(logger?: serverLogger, simulateThreats: boolean = false) {
        this.logger = logger || getLogger('mock_file_scanner');
        this.simulateThreats = simulateThreats;
    }

    getName(): string {
        return 'MockScanner';
    }

    isAvailable(): boolean {
        return true; // Always available
    }

    async scanFile(filePath: string, buffer?: Buffer): Promise<ScanResult> {
        this.logger.debug(`Mock scanning file: ${filePath}`);

        if (this.simulateThreats) {
            // Simulate finding a threat in files with "malicious" in name
            if (filePath.toLowerCase().includes('malicious') ||
                (buffer && buffer.toString().toLowerCase().includes('malicious'))) {
                return {
                    safe: false,
                    scanned: true,
                    result: 'Mock threat detected',
                    threat: 'Mock threat',
                    scanner: 'MockScanner'
                };
            }
        }

        return {
            safe: true,
            scanned: false,
            result: 'Not scanned: no malware scanner is configured',
            scanner: 'MockScanner'
        };
    }
}

/**
 * Reads clamd's reply to INSTREAM. Only an exact "stream: OK" is clean; "stream: <signature> FOUND" is a threat
 * (the signature name may contain any text, "OK" included); anything else, such as
 * "INSTREAM size limit exceeded. ERROR", means the file was not scanned.
 */
export function parseClamdReply(reply: string): ScanResult {
    const line = reply.replace(/\0/g, '').trim();
    if (line === 'stream: OK') {
        return {safe: true, scanned: true, result: 'File passed ClamAV scan', scanner: 'ClamAV'};
    }
    const found = /^stream: (.+) FOUND$/.exec(line);
    if (found) {
        return {safe: false, scanned: true, result: `Threat detected: ${found[1]}`, threat: found[1], scanner: 'ClamAV'};
    }
    return {safe: false, scanned: false, error: `Unexpected ClamAV reply: ${line || '(none)'}`, scanner: 'ClamAV'};
}

const INSTREAM_CHUNK_BYTES = 1024 * 1024;
/** Long enough for clamd to scan a large file (its own MaxScanTime defaults to 120 s); applies while the socket is idle. */
export const CLAMAV_SCAN_TIMEOUT_MS = 180_000;

/**
 * ClamAV Scanner - Uses ClamAV daemon via TCP socket (zINSTREAM). Fails closed: an unreachable daemon, a timeout or
 * an unexpected reply returns `safe: false`.
 */
export class ClamAVScanner implements FileScanner {
    private logger: serverLogger;
    private host: string;
    private port: number;
    private timeout: number;

    constructor(
        host: string = 'localhost',
        port: number = 3310,
        timeout: number = CLAMAV_SCAN_TIMEOUT_MS,
        logger?: serverLogger
    ) {
        this.logger = logger || getLogger('clamav_scanner');
        this.host = host;
        this.port = port;
        this.timeout = timeout;
    }

    getName(): string {
        return 'ClamAV';
    }

    isAvailable(): boolean {
        return true;
    }

    async scanFile(filePath: string, buffer?: Buffer): Promise<ScanResult> {
        const data = buffer ?? await fs.promises.readFile(filePath);

        return new Promise<ScanResult>(resolve => {
            let reply = '';
            let settled = false;
            const finish = (result: ScanResult) => {
                if (settled) return;
                settled = true;
                socket.destroy();
                if (!result.scanned) this.logger.err(`ClamAV scan of ${filePath} failed: ${result.error}`);
                resolve(result);
            };
            const fail = (error: string) => finish({safe: false, scanned: false, error, scanner: 'ClamAV'});

            const socket = net.createConnection({host: this.host, port: this.port}, () => {
                socket.write('zINSTREAM\0');
                for (let offset = 0; offset < data.length; offset += INSTREAM_CHUNK_BYTES) {
                    const chunk = data.subarray(offset, offset + INSTREAM_CHUNK_BYTES);
                    const size = Buffer.alloc(4);
                    size.writeUInt32BE(chunk.length, 0);
                    socket.write(size);
                    socket.write(chunk);
                }
                socket.write(Buffer.alloc(4)); // A zero-length chunk ends the stream.
            });
            socket.setTimeout(this.timeout);

            socket.on('data', (chunk: Buffer) => {
                reply += chunk.toString();
                // A z-prefixed command's reply ends with NUL.
                if (reply.includes('\0')) finish(parseClamdReply(reply));
            });
            socket.on('end', () => finish(parseClamdReply(reply)));
            socket.on('close', () => finish(parseClamdReply(reply)));
            // clamd answers a stream over its size limit and then closes, so a broken pipe may follow a reply that explains it.
            socket.on('error', (error: Error) => (reply ? finish(parseClamdReply(reply)) : fail(error.message)));
            socket.on('timeout', () => fail('ClamAV scan timeout'));
        });
    }
}

/**
 * Scanner Factory - Creates appropriate scanner based on configuration
 */
export class FileScannerFactory {
    static createScanner(logger?: serverLogger): FileScanner {
        switch ((FILE_UPLOAD.FILE_SCANNER_TYPE ?? '').toLowerCase()) {
            case 'clamav':
                return new ClamAVScanner(FILE_UPLOAD.CLAMAV_HOST, FILE_UPLOAD.CLAMAV_PORT, CLAMAV_SCAN_TIMEOUT_MS, logger);

            case 'mock':
            default:
                return new MockFileScanner(logger, FILE_UPLOAD.MOCK_SCANNER_SIMULATE_THREATS);
        }
    }
}

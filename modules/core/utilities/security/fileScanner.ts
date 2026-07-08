/**
 * File Security Scanner
 * 
 * Pluggable security scanning layer for uploaded files.
 * Supports multiple backends: ClamAV, VirusTotal API, or mock scanner.
 */

import {getLogger, serverLogger} from '@coreModule/loggers/serverLog';
import fs from 'fs';
import path from 'path';
import {FILE_UPLOAD} from "@coreModule/environment";

export interface ScanResult {
    safe: boolean;
    scanned: boolean;
    result?: string;
    error?: string;
    scanner?: string;
}

export interface FileScanner {
    scanFile(filePath: string, buffer?: Buffer): Promise<ScanResult>;
    isAvailable(): boolean;
    getName(): string;
}

/**
 * Mock Scanner - For development/testing
 * Always returns safe (can be configured to simulate threats)
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
        
        // Simulate scanning delay
        await new Promise(resolve => setTimeout(resolve, 100));

        if (this.simulateThreats) {
            // Simulate finding a threat in files with "malicious" in name
            if (filePath.toLowerCase().includes('malicious') || 
                (buffer && buffer.toString().toLowerCase().includes('malicious'))) {
                return {
                    safe: false,
                    scanned: true,
                    result: 'Mock threat detected',
                    scanner: 'MockScanner'
                };
            }
        }

        return {
            safe: true,
            scanned: true,
            result: 'File passed mock scan',
            scanner: 'MockScanner'
        };
    }
}

/**
 * ClamAV Scanner - Uses ClamAV daemon via TCP socket
 */
export class ClamAVScanner implements FileScanner {
    private logger: serverLogger;
    private host: string;
    private port: number;
    private timeout: number;

    constructor(
        host: string = 'localhost',
        port: number = 3310,
        timeout: number = 30000,
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
        try {
            const net = require('net');
            return true; // TCP module is available
        } catch {
            return false;
        }
    }

    async scanFile(filePath: string, buffer?: Buffer): Promise<ScanResult> {
        try {
            const net = require('net');
            const data = buffer || fs.readFileSync(filePath);

            return new Promise((resolve, reject) => {
                const socket = new net.Socket();
                let response = '';

                socket.setTimeout(this.timeout);
                socket.connect(this.port, this.host, () => {
                    // Send SCAN command with file data
                    const command = `zINSTREAM\0`;
                    socket.write(command);
                    
                    // Send file size and data
                    const size = Buffer.alloc(4);
                    size.writeUInt32BE(data.length, 0);
                    socket.write(size);
                    socket.write(data);
                    
                    // Send zero-length chunk to signal end
                    socket.write(Buffer.alloc(4).fill(0));
                });

                socket.on('data', (chunk: Buffer) => {
                    response += chunk.toString();
                });

                socket.on('end', () => {
                    // Parse ClamAV response
                    // Format: "stream: OK" or "stream: <virus_name> FOUND"
                    if (response.includes('OK')) {
                        resolve({
                            safe: true,
                            scanned: true,
                            result: 'File passed ClamAV scan',
                            scanner: 'ClamAV'
                        });
                    } else if (response.includes('FOUND')) {
                        const threatName = response.match(/stream: (.+?) FOUND/)?.[1] || 'Unknown threat';
                        resolve({
                            safe: false,
                            scanned: true,
                            result: `Threat detected: ${threatName}`,
                            scanner: 'ClamAV'
                        });
                    } else {
                        resolve({
                            safe: false,
                            scanned: true,
                            result: `Unexpected response: ${response}`,
                            scanner: 'ClamAV'
                        });
                    }
                });

                socket.on('error', (error: Error) => {
                    this.logger.err(`ClamAV scan error: ${error.message}`);
                    reject({
                        safe: false,
                        scanned: false,
                        error: error.message,
                        scanner: 'ClamAV'
                    });
                });

                socket.on('timeout', () => {
                    socket.destroy();
                    reject({
                        safe: false,
                        scanned: false,
                        error: 'ClamAV scan timeout',
                        scanner: 'ClamAV'
                    });
                });
            });
        } catch (error: any) {
            this.logger.err(`ClamAV scan failed: ${error.message}`);
            return {
                safe: false,
                scanned: false,
                error: error.message,
                scanner: 'ClamAV'
            };
        }
    }
}

/**
 * VirusTotal API Scanner - Uses VirusTotal API
 */
export class VirusTotalScanner implements FileScanner {
    private logger: serverLogger;
    private apiKey: string;
    private apiUrl: string;

    constructor(apiKey: string, logger?: serverLogger) {
        this.logger = logger || getLogger('virustotal_scanner');
        this.apiKey = apiKey;
        this.apiUrl = 'https://www.virustotal.com/vtapi/v2';
    }

    getName(): string {
        return 'VirusTotal';
    }

    isAvailable(): boolean {
        return !!this.apiKey && this.apiKey.length > 0;
    }

    async scanFile(filePath: string, buffer?: Buffer): Promise<ScanResult> {
        try {
            const crypto = require('crypto');
            const fs = require('fs').promises;
            const FormData = require('form-data');
            const axios = require('axios');

            const data = buffer || await fs.readFile(filePath);
            const hash = crypto.createHash('sha256').update(data).digest('hex');

            // First, check if file was already scanned
            const checkResponse = await axios.get(`${this.apiUrl}/file/report`, {
                params: {
                    apikey: this.apiKey,
                    resource: hash
                }
            });

            if (checkResponse.data.response_code === 1) {
                // File was already scanned
                const positives = checkResponse.data.positives || 0;
                return {
                    safe: positives === 0,
                    scanned: true,
                    result: `${positives} engines detected threats`,
                    scanner: 'VirusTotal'
                };
            }

            // Upload and scan new file
            const form = new FormData();
            form.append('file', data, path.basename(filePath));

            const uploadResponse = await axios.post(
                `${this.apiUrl}/file/scan`,
                form,
                {
                    headers: form.getHeaders(),
                    params: {
                        apikey: this.apiKey
                    }
                }
            );

            // Wait a bit and check result
            await new Promise(resolve => setTimeout(resolve, 5000));

            const resultResponse = await axios.get(`${this.apiUrl}/file/report`, {
                params: {
                    apikey: this.apiKey,
                    resource: uploadResponse.data.scan_id
                }
            });

            const positives = resultResponse.data.positives || 0;
            return {
                safe: positives === 0,
                scanned: true,
                result: `${positives} engines detected threats`,
                scanner: 'VirusTotal'
            };

        } catch (error: any) {
            this.logger.err(`VirusTotal scan failed: ${error.message}`);
            return {
                safe: false,
                scanned: false,
                error: error.message,
                scanner: 'VirusTotal'
            };
        }
    }
}

/**
 * Scanner Factory - Creates appropriate scanner based on configuration
 */
export class FileScannerFactory {
    static createScanner(logger?: serverLogger): FileScanner {
        const scannerType = FILE_UPLOAD.FILE_SCANNER_TYPE;
        const simulateThreats = FILE_UPLOAD.MOCK_SCANNER_SIMULATE_THREATS;

        switch (scannerType.toLowerCase()) {
            case 'clamav':
                const clamavHost = FILE_UPLOAD.CLAMAV_HOST;
                const clamavPort = FILE_UPLOAD.CLAMAV_PORT;
                return new ClamAVScanner(clamavHost, clamavPort, 30000, logger);

            case 'virustotal':
                const apiKey = FILE_UPLOAD.VIRUSTOTAL_API_KEY;
                if (!apiKey) {
                    logger?.warn('VirusTotal API key not found, falling back to mock scanner');
                    return new MockFileScanner(logger, simulateThreats);
                }
                return new VirusTotalScanner(apiKey, logger);

            case 'mock':
            default:
                return new MockFileScanner(logger, simulateThreats);
        }
    }
}


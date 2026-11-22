import {execFile} from 'child_process';
import {promises as fs} from 'fs';
import os from 'os';
import path from 'path';
import {randomUUID} from 'crypto';

/** Longest one ffmpeg or ffprobe call may take before the check gives up. */
const FFMPEG_TIMEOUT_MS = 30_000;

/**
 * ffprobe or ffmpeg ran and could not read the file. Trying again will not help, unlike a missing ffmpeg or a
 * timeout, which are thrown as plain errors.
 */
export class UnreadableVideoError extends Error {}

function run(command: string, args: string[], expectBytes?: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        execFile(command, args, {encoding: 'buffer', timeout: FFMPEG_TIMEOUT_MS, maxBuffer: (expectBytes ?? 1024 * 1024) + 1024},
            (error, stdout, stderr) => {
                if (!error) return resolve(stdout);
                const message = `${command} failed: ${error.message} ${String(stderr).slice(0, 300)}`;
                // A numeric exit code means the program ran and refused the file; ENOENT, a timeout or a too-large
                // output are problems of the server.
                reject(typeof error.code === 'number' && !error.killed ? new UnreadableVideoError(message) : new Error(message));
            });
    });
}

type Probe = {format?: {duration?: string}; streams?: {codec_type?: string}[]};

/**
 * Frames spread over a video, each `size`×`size` RGB (3 bytes a pixel), for the content check (D177). Up to
 * `maxFrames`, one per two seconds for short videos, each taken from the middle of its stretch with a fast seek (no
 * full decode). ffmpeg needs a file it can seek in, so the video is written to a temporary file and removed after.
 * A file with sound only has no frames. Throws `UnreadableVideoError` when the file is not a video ffmpeg can read.
 */
export async function sampleVideoFrames(video: Buffer, size: number, maxFrames: number): Promise<Buffer[]> {
    const file = path.join(os.tmpdir(), `moderation-${randomUUID()}`);
    await fs.writeFile(file, video);
    try {
        const probed = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file]);
        let probe: Probe;
        try {
            probe = JSON.parse(probed.toString());
        } catch {
            throw new UnreadableVideoError('ffprobe gave no readable description of the file');
        }
        if (!probe.streams?.some(stream => stream.codec_type === 'video')) {
            if (probe.streams?.some(stream => stream.codec_type === 'audio')) return [];
            throw new UnreadableVideoError('the file has no video or audio stream');
        }
        const duration = Number.parseFloat(probe.format?.duration ?? '');
        const length = Number.isFinite(duration) && duration > 0 ? duration : 0;
        const count = Math.max(1, Math.min(maxFrames, Math.ceil(length / 2)));
        const frameBytes = size * size * 3;
        const frames: Buffer[] = [];
        for (let index = 0; index < count; index++) {
            const at = length * (index + 0.5) / count;
            const frame = await run('ffmpeg', [
                '-v', 'error', '-ss', at.toFixed(3), '-i', file, '-frames:v', '1',
                '-vf', `scale=${size}:${size}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
            ], frameBytes);
            if (frame.length !== frameBytes) {
                throw new UnreadableVideoError(`ffmpeg gave ${frame.length} bytes for a ${size}×${size} frame at ${at.toFixed(1)} s`);
            }
            frames.push(frame);
        }
        return frames;
    } finally {
        await fs.unlink(file).catch(() => undefined);
    }
}

import {execFileSync} from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

function ffmpegFile(extension: string, args: string[]): Buffer {
    const file = path.join(os.tmpdir(), `test-media-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`);
    execFileSync("ffmpeg", ["-v", "error", "-y", ...args, file]);
    try {
        return fs.readFileSync(file);
    } finally {
        fs.unlinkSync(file);
    }
}

/** A generated test-pattern video of `seconds` seconds, made with ffmpeg so no video file sits in the repo. */
export function testVideo(seconds: number, container: "mp4" | "mov" = "mp4"): Buffer {
    return ffmpegFile(container, ["-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=160x120:rate=10`, "-pix_fmt", "yuv420p"]);
}

/** An MP4 with a tone and no pictures. */
export function soundOnlyMp4(seconds: number): Buffer {
    return ffmpegFile("mp4", ["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:a", "aac"]);
}

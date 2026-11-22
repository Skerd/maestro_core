import {describe, expect, it} from "vitest";
import {sampleVideoFrames, UnreadableVideoError} from "@coreModule/utilities/media/videoFrames";
import {soundOnlyMp4, testVideo} from "@coreModule/_tests/testVideo";

describe("sampleVideoFrames (D177)", () => {
    it("takes one frame per two seconds, as raw RGB frames of the asked size", async () => {
        const frames = await sampleVideoFrames(testVideo(7), 224, 12);
        expect(frames).toHaveLength(4);
        for (const frame of frames) expect(frame.length).toBe(224 * 224 * 3);
    });

    it("takes no more than the cap from a long video", async () => {
        expect(await sampleVideoFrames(testVideo(30), 32, 6)).toHaveLength(6);
    });

    it("finds no frames in a file with sound only", async () => {
        expect(await sampleVideoFrames(soundOnlyMp4(2), 32, 4)).toEqual([]);
    });

    it("says the file is unreadable when it is not a video", async () => {
        await expect(sampleVideoFrames(Buffer.from("not a video at all"), 32, 4)).rejects.toBeInstanceOf(UnreadableVideoError);
    });
});

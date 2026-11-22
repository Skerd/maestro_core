import {describe, expect, it} from "vitest";
import path from "path";
import sharp from "sharp";
import {
    LocalContentModerator,
    MODERATION_FRAME_SIZE,
    moderationVerdict,
    worstScores,
    type ModerationScores,
} from "@coreModule/utilities/security/contentModerator";

const scores = (overrides: Partial<ModerationScores>): ModerationScores =>
    ({porn: 0, hentai: 0, sexy: 0, neutral: 1, drawing: 0, ...overrides});

describe("moderationVerdict (default limits: refuse 0.85, flag 0.5, suggestive 0.95)", () => {
    it("refuses a clear porn or hentai score", () => {
        expect(moderationVerdict(scores({porn: 0.9}), true)).toBe("refused");
        expect(moderationVerdict(scores({hentai: 0.86}), true)).toBe("refused");
    });

    it("only flags a clear score where refusing is not allowed (health files)", () => {
        expect(moderationVerdict(scores({porn: 0.99}), false)).toBe("flagged");
    });

    it("flags a borderline explicit score and a very suggestive one", () => {
        expect(moderationVerdict(scores({porn: 0.6}), true)).toBe("flagged");
        expect(moderationVerdict(scores({sexy: 0.97}), true)).toBe("flagged");
    });

    it("passes the rest, swimwear-level suggestive scores included", () => {
        expect(moderationVerdict(scores({porn: 0.2, sexy: 0.8}), true)).toBe("passed");
    });
});

describe("worstScores", () => {
    it("lets the worst frame of an animation decide", () => {
        expect(worstScores([scores({porn: 0.1}), scores({porn: 0.7, neutral: 0.2}), scores({hentai: 0.3})]))
            .toMatchObject({porn: 0.7, hentai: 0.3, neutral: 0.2});
    });
});

describe("LocalContentModerator", () => {
    it("loads the model on the WebAssembly backend and scores an ordinary photo as neutral", async () => {
        const photo = path.join(__dirname, "../../../database/demo/media/1549317661-bd32c8ce0db2-1200x750.jpg");
        const rgb = await sharp(photo).resize(MODERATION_FRAME_SIZE, MODERATION_FRAME_SIZE, {fit: "fill"}).removeAlpha().raw().toBuffer();

        const result = await new LocalContentModerator().scoreFrame(rgb);

        expect(result.neutral).toBeGreaterThan(0.5);
        expect(moderationVerdict(result, true)).toBe("passed");
    }, 60000);
});

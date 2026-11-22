/**
 * Content moderation for uploaded images (D177): scores how likely an image is to show nudity or sexual content, so
 * `mediaUploadMW` can refuse a clear case and flag a borderline one. Pluggable like the file scanner: the local
 * detector, or none (`CONTENT_MODERATION=off`). Nothing leaves the server.
 */

import path from 'path';
import sharp from 'sharp';
import {getLogger} from '@coreModule/loggers/serverLog';
import {CONTENT_MODERATION} from '@coreModule/environment';
import {sampleVideoFrames} from '@coreModule/utilities/media/videoFrames';
import {documentImages} from '@coreModule/utilities/media/documentImages';

/** The detector's classes, each a probability (they add up to about 1). */
export type ModerationScores = {porn: number; hentai: number; sexy: number; neutral: number; drawing: number};

/** Side, in pixels, of the square RGB frame a detector scores. */
export const MODERATION_FRAME_SIZE = 224;

export interface ContentModerator {
    /** Scores one frame: `MODERATION_FRAME_SIZE`² pixels, RGB, 3 bytes each. Throws when the detector cannot run. */
    scoreFrame(rgb: Buffer): Promise<ModerationScores>;
}

type NsfwModel = {classify(image: unknown): Promise<{className: string; probability: number}[]>};

/**
 * nsfwjs (MobileNetV2) on the TensorFlow.js WebAssembly backend: about 25 ms a frame once loaded. The model loads on
 * the first frame (about 1.4 s), not when the server starts; a failed load is retried on the next frame.
 */
export class LocalContentModerator implements ContentModerator {
    private model: Promise<NsfwModel> | null = null;

    private load(): Promise<NsfwModel> {
        this.model ??= (async () => {
            const tf = await import('@tensorflow/tfjs');
            const wasm = await import('@tensorflow/tfjs-backend-wasm');
            // The backend's .wasm files sit next to its entry file.
            wasm.setWasmPaths(`${path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm'))}/`);
            await tf.setBackend('wasm');
            await tf.ready();
            const nsfwjs = await import('nsfwjs');
            const model = await nsfwjs.load('MobileNetV2');
            getLogger('content_moderation').info('Content moderation model loaded (nsfwjs MobileNetV2, wasm)');
            return model;
        })().catch((error: unknown) => {
            this.model = null;
            throw error;
        });
        return this.model;
    }

    async scoreFrame(rgb: Buffer): Promise<ModerationScores> {
        const model = await this.load();
        const tf = await import('@tensorflow/tfjs');
        const input = tf.tensor3d(new Int32Array(rgb), [MODERATION_FRAME_SIZE, MODERATION_FRAME_SIZE, 3], 'int32');
        try {
            const scores: ModerationScores = {porn: 0, hentai: 0, sexy: 0, neutral: 0, drawing: 0};
            for (const {className, probability} of await model.classify(input)) {
                const key = className.toLowerCase();
                if (key in scores) scores[key as keyof ModerationScores] = probability;
            }
            return scores;
        } finally {
            input.dispose();
        }
    }
}

let localModerator: LocalContentModerator | null = null;

/** The configured detector, or null when moderation is off. One local detector per process: its model is loaded once. */
export function contentModerator(): ContentModerator | null {
    if (CONTENT_MODERATION.MODE === 'off') return null;
    localModerator ??= new LocalContentModerator();
    return localModerator;
}

export type ModerationVerdict = 'passed' | 'flagged' | 'refused';

/**
 * What the scores mean under the configured limits: a clear porn or hentai score refuses (or only flags, where
 * refusing is not allowed: health data), a borderline one or a very suggestive one flags, the rest passes.
 */
export function moderationVerdict(scores: ModerationScores, canRefuse: boolean): ModerationVerdict {
    const explicit = Math.max(scores.porn, scores.hentai);
    if (explicit >= CONTENT_MODERATION.REFUSE_SCORE) return canRefuse ? 'refused' : 'flagged';
    if (explicit >= CONTENT_MODERATION.FLAG_SCORE || scores.sexy >= CONTENT_MODERATION.SUGGESTIVE_FLAG_SCORE) return 'flagged';
    return 'passed';
}

/** Frames of an animated image (GIF, WebP) that are scored, spread over the animation. */
const MAX_IMAGE_FRAMES = 5;
/** Frames of a video that are scored, spread over it (one per two seconds for short videos). */
const MAX_VIDEO_FRAMES = 12;
/** Pages of a PDF, or pictures inside an Office file, a document is checked on. */
const MAX_DOCUMENT_PICTURES = 10;

/** An image's frames as detector input; grayscale images (X-rays) become 3-channel RGB. */
async function imageFrames(image: Buffer): Promise<Buffer[]> {
    const {pages = 1} = await sharp(image).metadata();
    const count = Math.min(pages, MAX_IMAGE_FRAMES);
    const frames: Buffer[] = [];
    for (let index = 0; index < count; index++) {
        frames.push(await sharp(image, {page: Math.floor(index * pages / count)})
            .resize(MODERATION_FRAME_SIZE, MODERATION_FRAME_SIZE, {fit: 'fill'})
            .removeAlpha()
            .toColourspace('srgb')
            .raw()
            .toBuffer());
    }
    return frames;
}

/** What the content check looks at in a file: an image's frames, frames over a video, or a document's pictures. */
export type ModeratedKind = 'image' | 'video' | 'document';

async function framesOf(bytes: Buffer, kind: ModeratedKind): Promise<Buffer[]> {
    if (kind === 'video') return sampleVideoFrames(bytes, MODERATION_FRAME_SIZE, MAX_VIDEO_FRAMES);
    if (kind === 'image') return imageFrames(bytes);
    const frames: Buffer[] = [];
    for (const picture of await documentImages(bytes, MAX_DOCUMENT_PICTURES)) frames.push(...await imageFrames(picture));
    return frames;
}

/**
 * The worst scores over a file's frames: an image's, frames sampled over a video, or the pictures of a document (a
 * PDF's first pages, the pictures inside an Office file). Throws when the file cannot be read or the detector cannot
 * run.
 */
export async function scoreMediaFile(moderator: ContentModerator, bytes: Buffer, kind: ModeratedKind): Promise<ModerationScores> {
    const frames = await framesOf(bytes, kind);
    const scores: ModerationScores[] = [];
    for (const frame of frames) scores.push(await moderator.scoreFrame(frame));
    return worstScores(scores);
}

const round = (score: number): number => Math.round(score * 1000) / 1000;

/** Scores as stored with a file: three decimals. */
export function roundedScores(scores: ModerationScores): ModerationScores {
    return {porn: round(scores.porn), hentai: round(scores.hentai), sexy: round(scores.sexy), neutral: round(scores.neutral), drawing: round(scores.drawing)};
}

/** The highest score of each class across several frames (an animated image): the worst frame decides. */
export function worstScores(frames: ModerationScores[]): ModerationScores {
    return frames.reduce((worst, frame) => ({
        porn: Math.max(worst.porn, frame.porn),
        hentai: Math.max(worst.hentai, frame.hentai),
        sexy: Math.max(worst.sexy, frame.sexy),
        neutral: Math.min(worst.neutral, frame.neutral),
        drawing: Math.max(worst.drawing, frame.drawing),
    }), {porn: 0, hentai: 0, sexy: 0, neutral: 1, drawing: 0});
}

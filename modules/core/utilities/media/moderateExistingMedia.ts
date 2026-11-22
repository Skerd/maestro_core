import {Types} from 'mongoose';
import {serverLogger} from '@coreModule/loggers/serverLog';
import {mediaService} from '@coreModule/database/schemas/media/media.service';
import type {IMedia} from '@coreModule/database/schemas/media/media';
import {readMediaBytes} from '@coreModule/utilities/media/serveMedia';
import {
    ContentModerator,
    moderationVerdict,
    roundedScores,
    scoreMediaFile,
} from '@coreModule/utilities/security/contentModerator';

const BATCH_SIZE = 50;

export type ExistingMediaCheck = {checked: number; passed: number; flagged: number; notChecked: number; flaggedIds: string[]};

/**
 * Runs the content check (D177) over stored files it has not judged: files uploaded before it, and files it could not
 * check then (`not_checked`, tried again on every run). Flag only: a clear case is flagged, never deleted or refused,
 * since a record may already show the file; a file that cannot be read stays `not_checked`. `dryRun` reports without
 * writing.
 */
export async function moderateExistingMedia(options: {
    moderator: ContentModerator;
    types: ('image' | 'video' | 'pdf' | 'document')[];
    logger: serverLogger;
    dryRun?: boolean;
}): Promise<ExistingMediaCheck> {
    const {moderator, types, logger, dryRun = false} = options;
    const result: ExistingMediaCheck = {checked: 0, passed: 0, flagged: 0, notChecked: 0, flaggedIds: []};
    let afterId: Types.ObjectId | null = null;

    for (;;) {
        const batch = await mediaService.findNotModerated(types, afterId, BATCH_SIZE);
        for (const media of batch) {
            afterId = media._id;
            result.checked += 1;
            const kind = media.type === 'video' ? 'video' : media.type === 'image' ? 'image' : 'document';
            let moderation: NonNullable<IMedia['metadata']['moderation']>;
            try {
                const scores = await scoreMediaFile(moderator, await readMediaBytes(media, 'en-US'), kind);
                const verdict = moderationVerdict(scores, false);
                moderation = {status: verdict === 'flagged' ? 'flagged' : 'passed', scores: roundedScores(scores), checkedAt: new Date()};
            } catch (error) {
                logger.warn(`Content check could not run on media ${String(media._id)} (${media.originalName}): ${error instanceof Error ? error.message : error}`);
                moderation = {status: 'not_checked', checkedAt: new Date()};
            }
            if (moderation.status === 'flagged') {
                result.flagged += 1;
                result.flaggedIds.push(String(media._id));
                logger.warn(`Flagged media ${String(media._id)} (${media.originalName}, company ${String(media.company)}): ${JSON.stringify(moderation.scores)}`);
            } else if (moderation.status === 'passed') {
                result.passed += 1;
            } else {
                result.notChecked += 1;
            }
            if (!dryRun) await mediaService.setModeration(media._id, moderation);
        }
        if (batch.length < BATCH_SIZE) break;
    }
    return result;
}

import type {MediaSimple} from "armonia/src/modules/core/dto/media.dto";
import type {IMedia} from "@coreModule/database/schemas/media/media";
import {defineSnippet} from "@coreModule/database/utilities/snippet";

export const MediaSimpleSnippet = defineSnippet<IMedia, MediaSimple>()({
    keys: {
        _id: {},
        fileName: {},
        extension: {},
        mimeType: {},
        metadata: {},
        resolution: {
            keys: {
                width: {},
                height: {},
            },
        },
    },
});

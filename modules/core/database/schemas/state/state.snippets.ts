import type {StateSimple} from "armonia/src/modules/core/dto/state.dto";
import type {IState} from "@coreModule/database/schemas/state/state";
import {defineSnippet} from "@coreModule/database/utilities/snippet";

export const StateSimpleSnippet = defineSnippet<IState, StateSimple>()({
    keys: {
        _id: {},
        name: {},
        code: {},
    },
});

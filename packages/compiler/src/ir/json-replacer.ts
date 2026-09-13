import { DYN, STRING } from "./type-constants.js";

/** The callback is boxed; validation of its typed ABI happens before boxing. */
export const JSON_REPLACER_SIGS = {
  "json.stringifyReplacer": { argTypes: [DYN, DYN, STRING], result: STRING },
};
export type IrJsonReplacerFn = keyof typeof JSON_REPLACER_SIGS;

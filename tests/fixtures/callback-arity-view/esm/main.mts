import { pick } from "./source.mjs";
const record: { parse: (first: number, second: number) => number } = { parse: pick };
console.log("module", record.parse(4, 9), record.parse === pick);

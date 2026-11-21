// @ts-nocheck
import { site as first } from "./a.mjs";
import { site as second } from "./b.mjs";
const tag = parts => parts;
const a = first(tag);
const b = first(tag);
const c = second(tag);
console.log("module-sites", a === b, a === c, a.raw === b.raw, a.raw === c.raw);

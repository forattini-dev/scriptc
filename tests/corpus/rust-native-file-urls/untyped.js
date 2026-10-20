// @rust-only
// @no-engine
import { fileURLToPath } from "node:url";
const holder = { url: import.meta.url, filename: import.meta.filename };
function own() { return import.meta.url; }
console.log(fileURLToPath(holder.url) === holder.filename, own() === holder.url);
{ const fileURLToPath = (value = "") => "shadow:" + value; console.log(fileURLToPath("value")); }

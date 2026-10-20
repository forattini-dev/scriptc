// @rust-only
// @no-engine
import * as urls from "node:url";
function input(): string { console.log("input"); return import.meta.url; }
console.log("converted", urls.fileURLToPath(input()) === import.meta.filename);
function invalid(): string { console.log("invalid"); return "http://example.com"; }
try { console.log(urls.fileURLToPath(invalid())); }
catch (error) { if (error instanceof Error) console.log("error", error.name, error.message); }

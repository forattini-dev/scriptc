// @rust-only
// @no-engine
import { fileURLToPath as pathOf } from "node:url";
import path from "node:path";
const prefix = process.platform === "win32" ? "file:///C:/" : "file:///";
function check(suffix: string): void { console.log(pathOf(prefix + suffix)); }
check("a%20b/100%25/caf%C3%A9"); check("a/../b"); check("a%23b%3Fc?ignored#fragment");
check("a%00b"); check("a%252Fb"); check("a\\b"); check("a/%E4%BD%A0%E5%A5%BD");
console.log("source", path.normalize(pathOf(import.meta.url)) === import.meta.filename);
console.log("directory", path.dirname(import.meta.filename) === import.meta.dirname);

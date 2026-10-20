// @rust-only
// @no-engine
import { fileURLToPath } from "node:url";
const prefix = process.platform === "win32" ? "file:///C:/" : "file:///";
function check(input: string): void {
  try { console.log("path", fileURLToPath(input)); }
  catch (error) { if (error instanceof Error) console.log("error", error.name, error.message); }
}
check("not a URL"); check("http://example.com/x"); check(prefix + "a%2Fb"); check(prefix + "%");
check(prefix + "%zz"); check(prefix + "%FF"); check(prefix + "%C0%AF"); check(prefix + "%ED%A0%80");
check(prefix + "%E2%82"); check(prefix + "%5C"); check(prefix + "%zz%2F");
try { console.log("host", fileURLToPath("file://server/share/file")); }
catch (error) { if (error instanceof Error) console.log("error", error.name, error.message); }
check("file://測試/share/caf%C3%A9"); check("file:///no-drive"); check("file:///C%3A/path");
check("file:///no-drive/%zz"); check("file://server/%FF");

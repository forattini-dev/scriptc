// @rust-only
// @no-engine
import path, { join as joinPath, basename } from "node:path";
import * as posix from "node:path/posix";
import { normalize as winNormalize } from "node:path/win32";
import { existsSync as present } from "node:fs";
import { platform } from "node:os";
import { readFile } from "node:fs/promises";
import * as child from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
console.log("default", joinPath("a", "..", "b", "ação"), path.dirname("/a/b/file.ts"));
console.log("basename", basename("/a/b/file.ts"), basename("/a/b/file.ts", ".ts"));
console.log("posix", posix.join("a", "..", "b"), posix.resolve("/tmp", "a", "..", "b"));
console.log("windows", winNormalize("C:\\a\\..\\b\\"), path.win32.basename("C:\\a\\file.ts", ".ts"));
console.log("predicates", posix.isAbsolute("/a"), path.win32.isAbsolute("C:\\a"), present("tests/corpus/rust-native-builtins/main.ts"), present("scriptc-deliberately-missing-native-file"));
console.log("platform", platform(), process.platform);
console.log("cwd", process.cwd());
function arrayInput(values: string[]): string[] { return values; }
const words = arrayInput(["a", "b"]);
// Arrays have native ownership and can be passed/returned; inspection and indexed reads are separate migrations.
console.log("arrays", posix.join());

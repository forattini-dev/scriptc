// @dynamic
// @rust-only
// @island-module: ./proc.ts
// node:child_process inside the island over the runtime's child unit:
// spawn with piped stdio and Node's event order, exec/execFile, ENOENT as
// an 'error' event, a piped stdin, kill, and the sync forms.
import { piped, viaExec, execFailure, missing, stdinRoundTrip, killed, withCwdAndEnv, sync } from "./proc.ts";

console.log(await piped());
console.log(await viaExec());
console.log(await execFailure());
console.log(await missing());
console.log(await stdinRoundTrip());
console.log(await killed());
console.log(await withCwdAndEnv());
console.log(sync());

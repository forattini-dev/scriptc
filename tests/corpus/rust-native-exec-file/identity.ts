// @rust-only
// @no-engine
import { execFile as execute } from "node:child_process";
import { promisify as promiseFunction } from "node:util";
import * as processes from "node:child_process";

const raw = execute;
const run = promiseFunction(raw);
const alias = run;
console.log("types", typeof raw, typeof run, raw === processes.execFile);
console.log(run === promiseFunction(execute), alias === run);
console.log(promiseFunction(run) === run);

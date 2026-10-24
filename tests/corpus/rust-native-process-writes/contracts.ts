// @rust-only
// @no-engine
import proc, { stdout as out, stderr as err } from "node:process";
import * as ns from "node:process";
process.stdout.write("start:");
process.stdout.write("a\0b\n");
proc.stderr.write("error:");
err.write("sem newline");
ns.stderr.write("\n");
out.write("Português 🌍 " + "🌍".slice(0, 1) + " " + "🌍".slice(1) + "\n");
process["stdout"]["write"]("");
process["stderr"].write("computed\n");
console.log("done");
const localProcess = { stderr: { write(text: string): boolean { console.log("shadow", text); return false; } } };
localProcess.stderr.write("local");

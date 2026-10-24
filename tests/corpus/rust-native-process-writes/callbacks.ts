// @rust-only
// @no-engine
import { setSink, warning } from "./sink.ts";
warning("original");
let seen = "";
const previous = setSink((message: string): void => { seen = seen + message; process.stdout.write(`capture:${message}\n`); });
warning("changed");
previous("retained");
const replacement = setSink(previous);
warning("restored");
replacement("saved");
console.log("seen", seen);
function invoke(message: string, sink: (text: string) => void = (text) => process.stdout.write(text)): void { sink(message); }
invoke("default\n");
invoke("override\n", (text) => process.stderr.write(text));
function make(prefix: string): (text: string) => void {
  return (text) => process.stderr.write(`${prefix}:${text}\n`);
}
const alias = make("closure"); alias("one"); alias("two");

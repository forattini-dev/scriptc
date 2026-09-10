// @rust-only
// @no-engine
import { createEmitter, callCapture, replacement } from "./source.js";
interface Emitter {
  capture(values: string[]): string[];
  current(): string[];
  append(value: string): number;
  matches(values: string[]): boolean;
  reset(): string[];
}
const emitter: Emitter = createEmitter();
const input: string[] = ["host"];
const captured = emitter.capture(input);
console.log("input", captured === input, emitter.current() === input, emitter.matches(input), input.join(","));
input.push("typed");
console.log("append", emitter.append("dynamic"), input.join(","));
const fresh = emitter.reset();
const alias = emitter.current();
console.log("fresh", fresh === alias, fresh !== input, emitter.matches(fresh));
fresh.push("host");
emitter.append("library");
console.log("shared", alias.join(","));
alias[0] = "changed";
console.log("changed", emitter.current().join(","));
console.log("contains", [fresh].includes(alias), [fresh].indexOf(alias));
replacement(emitter);
console.log("replacement", emitter.capture(fresh) === fresh, fresh.join(","));
emitter.capture = (values: string[]): string[] => { values.push("callback"); return values; };
console.log("callback", callCapture(emitter, alias).join(","), fresh.join(","));

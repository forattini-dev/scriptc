// @ts-nocheck
// @rust-only
// @no-engine
let trace = "";
const object: Record<string, number | undefined> = {};
function key(): string { trace = trace + "K"; return "new"; }
function receiver(): unknown { trace = trace + "R"; object.new = undefined; return object; }
console.log("order", key() in receiver(), trace);
function failKey(): string { trace = trace + "T"; throw new Error("key"); }
try { console.log(failKey() in receiver()); }
catch (error) { if (error instanceof Error) console.log("key-throw", error.message, trace); else throw error; }
function failReceiver(): unknown { trace = trace + "E"; throw new Error("receiver"); }
try { console.log(key() in failReceiver()); }
catch (error) { if (error instanceof Error) console.log("rhs-throw", error.message, trace); else throw error; }
function invalid(value: unknown): void {
  try { console.log(key() in value); }
  catch (error) { console.log("invalid", error instanceof TypeError, trace); }
}
invalid(null); invalid(undefined); invalid(0); invalid(false); invalid("string"); invalid(1n); invalid(Symbol("rhs"));
console.log("short-circuit", false && (failKey() in receiver()), true || (failKey() in receiver()), trace);

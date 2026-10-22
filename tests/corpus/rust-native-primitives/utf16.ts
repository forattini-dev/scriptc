/// <reference lib="es2024.string" />
// @rust-only
// @no-engine
const high = "😀".slice(0, 1);
const low = "😀".slice(1);
const replacement = "�";
console.log("units", high.length, low.length, high.charCodeAt(0), low.charCodeAt(0));
console.log("identity", high === replacement, high === low, high + low === "😀", high.repeat(2).length);
console.log("repair", high.isWellFormed(), high.toWellFormed() === replacement, (high + low).isWellFormed());
console.log("output", high, low, high + low);
const values: string[] = [high, low];
console.log("array", values[0] === high, values[0] === replacement, values.join("") === "😀");
const map = new Map<string, string>();
map.set(high, low);
map.set(replacement, "other");
console.log("map", map.size, map.get(high) === low, map.get(replacement) === "other");
const set = new Set<string>([high, replacement, low, high]);
console.log("set", set.size, set.has(high), set.has(replacement));
const dict: Record<string, string> = {};
dict[high] = low;
dict[replacement] = "replacement";
console.log("dictionary", dict[high] === low, dict[replacement], json(dict));
const object = { text: high };
console.log("record", object.text === high, json(object));
const parsed: unknown = JSON.parse('{"\\ud83d":"\\ude00","�":"replacement"}');
console.log("json", json(parsed));
console.log("json keys", (parsed as any)[high] === low, (parsed as any)[replacement] === "replacement");
console.log("search units", high.includes(high), high.indexOf(replacement), high.padEnd(2, low) === "😀");
const mapped = values.map((value: string): string => value);
console.log("callback", mapped[0] === high, mapped[1] === low);
const symbol = Symbol.for(high);
console.log("symbol", symbol.description === high, symbol === Symbol.for(high), symbol !== Symbol.for(replacement));
Promise.resolve(high).then((value) => { console.log("promise", value === high, value.charCodeAt(0)); });
function identity(value: string): string { return value; }
console.log("call", identity(high) === high, high.toUpperCase() === high, high.trim() === high);
try { throw high; }
catch (error) { console.log("caught", typeof error === "string", error === high); }
class Message extends Error {}
const error = new Message(high);
console.log("error", error.message === high, error.toString() === "Error: " + high);

function json(value: unknown): string {
  const result = JSON.stringify(value);
  if (typeof result === "string") return result;
  return "undefined";
}

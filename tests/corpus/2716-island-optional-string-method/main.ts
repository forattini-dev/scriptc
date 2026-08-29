// @dynamic
// A package call returns a typed optional string through an island handle.
import { flatValue } from "flat-values";

function normalized(text: string, key: string): string {
  return flatValue(text, key)?.trim() ?? "missing";
}

console.log(normalized("mode=local", "mode"));
console.log(normalized("mode=local", "workers"));

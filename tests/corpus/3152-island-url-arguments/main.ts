// @dynamic
import { describe } from "urlinputs";

function source(kind: number): URL | Uint8Array | undefined {
  if (kind === 0) return new URL("https://user:pw@EXAMPLE.com:443/a%20b?q=1&q=2#part");
  if (kind === 1) return new Uint8Array([7, 200]);
  return undefined;
}
console.log(describe(source(0)));
console.log(describe(source(1)));
console.log(describe(source(2)));
console.log(describe(new URL("https://cdn.dev/image.png?x=3#end")));

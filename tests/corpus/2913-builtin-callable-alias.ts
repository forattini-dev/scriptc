// Immutable aliases of table-backed Node builtins are compile-time call
// targets. Direct calls retain each builtin's argument validation, and
// alias chains carry the same projection without allocating function slots.
import { basename } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const base = basename;
const baseAgain = base;
const pack = deflateSync;
const unpack = inflateSync;

const raw = Buffer.from("callable projection", "utf8");
console.log(baseAgain("/tmp/static-callable.ts", ".ts"));
console.log(unpack(pack(raw)).toString("utf8"));

function nested(path: string): string {
  const local = base;
  return local(path);
}
console.log(nested("/one/two/three.txt"));

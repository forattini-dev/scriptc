// @rust-only
// @dynamic
// C/LLVM still lose method receivers and reject the unknown callback boundary.
import { box, visit, sameUnknown } from "dynobjects";

function mark(): number { console.log("argument"); return 3; }

function exercise(value: unknown): void {
  const object: any = value;
  console.log("fields", `${object.count}`, `${object.text}`);
  object.count = 9;
  console.log("write", `${object.count}`);
  console.log("child", object.factory() === object.child);
  const fn = object.makeFn();
  console.log("function", typeof fn, `${fn(4)}`);
  console.log("keys", Object.keys(object).join(","));
  console.log("own", Object.hasOwn(object, "count"), Object.hasOwn(object, "missing"));
  console.log("in", "count" in object, "toString" in object, "missing" in object);
  const lone: unknown = object.lone;
  console.log("utf16", (lone as string).charCodeAt(0));
  console.log("order", `${object.method(mark())}`);
  const unbound = object.method;
  console.log("unbound", `${unbound(2)}`);
  console.log("array", Array.isArray(object.items), `${object.items.join("-")}`);
}
const wrapped: unknown = box;
exercise(wrapped);
console.log("original", `${box.count}`);

console.log(visit((value: unknown): string => {
  if (value === 5) return "five";
  if (typeof value === "string") return value;
  return String(value);
}));

// Unknown callback inputs retain identity, including executable properties.
function identity(value: unknown): unknown { return value; }
console.log(sameUnknown(identity));

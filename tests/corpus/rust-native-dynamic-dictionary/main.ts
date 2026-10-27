// @rust-only
// @no-engine
export {};
type JsonObject = Record<string, unknown>;
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function view(value: unknown): JsonObject {
  if (!isObject(value) || !isObject(value.color)) throw new Error("bad document");
  return value;
}
const raw: unknown = JSON.parse('{"color":{"name":"red"},"n":1}');
const object = view(raw);
const alias: any = raw;
console.log("identity", object === raw, (object.color as any) === alias.color);
object.n = 2;
alias.extra = "new";
console.log("writes", alias.n === 2, object.extra === "new", Object.keys(object).join("|"));

delete object.n;
console.log("delete", alias.n === undefined, Object.keys(object).join("|"));
function dictionary(value: unknown): JsonObject {
  if (!isObject(value)) throw new Error("not an object");
  return value;
}
const typed = { name: "one" };
const typedView = dictionary(typed);
typedView.name = "changed";
console.log("typed", (typed as any) === (typedView as any), typed.name, typedView.name === "changed");

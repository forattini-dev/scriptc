// @rust-only
// @no-engine
// @ts-nocheck
export {};
const object: any = { own: undefined, name: "value", hasOwnProperty: false };
console.log("own", Object.prototype.hasOwnProperty.call(object, "own"), Object.prototype.hasOwnProperty.call(object, "name"));
console.log("missing", Object.prototype.hasOwnProperty.call(object, "missing"), Object.prototype.hasOwnProperty.call(object, "toString"));
let trace = "";
function receiver(): any { trace += "r"; return object; }
function key(): string { trace += "k"; return "name"; }
console.log("order", Object.prototype.hasOwnProperty.call(receiver(), key()), trace);
try { Object.prototype.hasOwnProperty.call(null, key()); }
catch (error) { console.log("error", error instanceof TypeError, trace); }
function shadow(): boolean {
  const Object = { prototype: { hasOwnProperty: { call: (obj: any, key: string) => true } } };
  return Object.prototype.hasOwnProperty.call({}, "missing");
}
console.log("shadow", shadow());

// @rust-only
// @no-engine
const nan = 0 / 0;
var pending = new Map();
function store(key: unknown, value: unknown): void { pending.set(key, value); }
function read(key: unknown): unknown { return pending.get(key); }
function has(key: unknown): unknown { return pending.has(key); }
function remove(key: unknown): unknown { return pending.delete(key); }
store("request", 7);
store(1, "number");
store("1", "string");
store(true, "bool");
store(null, "null");
store(undefined, "undefined");
store(nan, "first");
store(nan, "second");
store(-0, "zero");
console.log(read("request") === 7, read(1) === "number", read("1") === "string", read(true) === "bool");
console.log(read(null) === "null", read(undefined) === "undefined", read(nan) === "second", read(0) === "zero");
console.log(has("request") === true, has("missing") === false, read("missing") === undefined, pending.size);
const object = { value: 1 };
const other = { value: 1 };
const array = [1, 2];
const fn = (n: number): number => n + 1;
store(object, array);
store(array, fn);
store(fn, object);
console.log(read(object) === array, read(other) === undefined, read(array) === fn, read(fn) === object);
store(object, "replaced");
console.log(read(object) === "replaced", remove(object) === true, remove(object) === false);
const alias: any = pending;
console.log(alias.set("chain", 8) === alias, alias.get("chain") === 8);
alias.set();
console.log(alias.has(undefined) === true, alias.get(undefined) === undefined);
console.log(alias.clear() === undefined, pending.size);
function cycle(): void {
  const map = new Map();
  map.set(map, map);
  console.log(map.get(map) === map, map.size);
}
cycle();

function effect(label: string, value: unknown): unknown { console.log("effect", label); return value; }
function receiver(): any { console.log("effect", "receiver"); return alias; }
receiver().set(effect("key", "ordered"), effect("value", 9), effect("extra", false));
console.log(alias.get("ordered", effect("unused", false)) === 9);
const fault = new Error("identity");
store(fault, "error-key");
console.log(read(fault) === "error-key", read(new Error("identity")) === undefined);

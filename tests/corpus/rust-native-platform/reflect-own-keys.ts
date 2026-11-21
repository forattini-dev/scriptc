// @rust-only
// @no-engine
export {};

const tag = Symbol("tag");
const object: any = { 2: "two", first: 1 };
Object.defineProperty(object, "hidden", { value: 3 });
Object.defineProperty(object, tag, { value: 4 });
const keys = Reflect.ownKeys(object);
console.log(
  "own keys",
  keys.length,
  keys.map((key) => typeof key).join(","),
);

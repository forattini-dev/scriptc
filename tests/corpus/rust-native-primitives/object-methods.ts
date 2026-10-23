// @rust-only
// @no-engine
export {};
interface Counter {
  value: number;
  read(): number;
  write(value: number): void;
  describe(prefix?: string): string;
}
const counter: Counter = {
  value: 3,
  read() { return this.value; },
  write(value) { this.value = value; },
  describe(prefix = "value") { return prefix; },
};
console.log("initial", counter.read(), counter.describe(), counter.describe("named"));
counter.write(7);
console.log("write", counter.read());
const read = counter.read;
const other = { value: 9 };
console.log("borrowed", read.call(other), read === counter.read);
try { read(); }
catch (error) { if (error instanceof Error) console.log("bare", error.name, error.message); else throw error; }
function make(prefix: string) {
  return { label(value: string): string { return prefix + value; } };
}
const first = make("a:");
const second = make("b:");
console.log("captures", first.label("x"), second.label("x"), first.label === second.label);
const optional = { value: "default", read(this: { value: string }, value: string = this.value): string { return value; } };
console.log("default this", optional.read(), optional.read("explicit"));
const spread = { ...counter, read() { return this.value; } };
spread.value = 12;
console.log("spread", spread.read(), counter.read());
const erased: unknown = { value: "erased", read(this: { value: string }): string { return this.value; } };
console.log("erased", (erased as any).read() === "erased");
const hooks = { toJSON(): string { return "method hook"; } };
console.log("json", JSON.stringify(hooks) === '"method hook"');
function fresh() { return { read(): string { return "fresh"; } }; }
const freshA = fresh();
const freshB = fresh();
console.log("fresh identity", freshA.read === freshB.read, freshA.read());
interface OptionalMethod { read?(): number; }
const optionalMethod: OptionalMethod = { read() { return 5; } };
const maybeRead = optionalMethod.read;
if (maybeRead) console.log("optional", maybeRead());
const inline = { ...{ label(): string { return "inline"; } } };
console.log("inline spread", inline.label());
const keys = { value: 3, 3(): number { return this.value; }, __proto__(): string { return "own"; } };
console.log("keys", keys[3](), keys.__proto__());
counter.read = function(): number { return 99; };
console.log("replacement", counter.read(), read.call(counter), read === counter.read);
let hits = 0;
const deferred = { hit(): void { hits = hits + 1; } };
console.log("deferred before", hits);
deferred.hit();
console.log("deferred after", hits);

// @rust-only
// @no-engine
function text(label: string, value: string): Promise<string> {
  console.log("evaluate", label);
  return Promise.resolve(value);
}
function number(label: string, value: number): Promise<number> {
  console.log("evaluate", label);
  return Promise.resolve(value);
}
const all = Promise.all([text("first", " a "), number("second", 7), Promise.resolve(true)]);
queueMicrotask(() => console.log("queued before await"));
const [a, b, c] = await all;
console.log(a.trim(), b + 1, !c);
const scheduled = Promise.all([Promise.resolve("scheduled"), Promise.resolve(2)]);
scheduled.then(() => console.log("combined reaction"));
Promise.resolve().then(() => console.log("tick one")).then(() => console.log("tick two"));
await scheduled;
console.log("resumed");

// Numeric positions must not follow the record shape's lexical field order.
const many = await Promise.all([
  Promise.resolve("zero"), Promise.resolve(1), Promise.resolve(2), Promise.resolve(3),
  Promise.resolve(4), Promise.resolve(5), Promise.resolve(6), Promise.resolve(7),
  Promise.resolve(8), Promise.resolve(9), Promise.resolve("ten"), Promise.resolve(false),
]);
console.log(many[0], many[10], many[11], many.length, JSON.stringify(many));

// Completion order differs from input order; preserve object identity.
const object = { value: 3 };
const alias = Promise.resolve(object);
const [slow, fast, left, right] = await Promise.all([
  new Promise<string>(resolve => setTimeout(() => resolve("slow"), 10)),
  Promise.resolve(4), alias, alias,
]);
left.value = 9;
console.log(slow, fast, left === right, right.value, object.value);

const reason = new Error("first reason");
const firstRejected: Promise<string> = Promise.reject(reason);
const secondRejected: Promise<number> = Promise.reject(new Error("later reason"));
try {
  await Promise.all([firstRejected, secondRejected]);
} catch (error) {
  console.log("rejection", (error as Error) === reason, (error as Error).message);
}
// A later synchronous throw must happen before Promise.all observes entries.
function fail(): Promise<number> { console.log("throw entry"); throw new Error("evaluation"); }
try { await Promise.all([text("before throw", "x"), fail(), text("unreachable", "z")]); }
catch (error) { console.log((error as Error).message); }

// Suspensions while constructing the input still evaluate left to right.
const nested = await Promise.all([text("before suspend", "x"), Promise.resolve(await number("suspend", 5))]);
console.log(nested[0], nested[1]);
async function pair(): Promise<[string, number]> {
  return Promise.all([Promise.resolve("adopted"), Promise.resolve(8)]);
}
const [adopted, code] = await pair();
console.log(adopted, code);
export {};

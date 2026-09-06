// @rust-only
// Collection combinators on the native kernel: Effect.forEach (with the
// index, and with discard), Effect.all over a tuple, over an array built
// by map, and over a record. The kernel runs them sequentially.
import { Effect } from "effect";

const names = ["ana", "bo", "cy"];

const labeled = Effect.forEach(names, (name, index) => Effect.succeed(`${index}:${name.toUpperCase()}`));
console.log(Effect.runSync(labeled).join(" "));

const seen: string[] = [];
const noted = Effect.forEach(names, (name) => Effect.sync(() => { seen.push(name); }), { discard: true });
Effect.runSync(noted);
console.log(seen.length, seen.join(","));

const pair = Effect.all([Effect.succeed(21), Effect.sync(() => "x")]);
const [n, s] = Effect.runSync(pair);
console.log(n * 2, s);

const lengths = Effect.all(names.map((name) => Effect.succeed(name.length)));
console.log(Effect.runSync(lengths).join("+"));

const shaped = Effect.all({ count: Effect.succeed(names.length), first: Effect.succeed(names[0]!) });
const result = Effect.runSync(shaped);
console.log(result.count, result.first);

const failing = Effect.all(names.map((name) => (name === "bo" ? Effect.fail("stop") : Effect.succeed(name.length))));
console.log(Effect.runSync(Effect.catch(failing, (e) => Effect.succeed([e.length]))).join(","));

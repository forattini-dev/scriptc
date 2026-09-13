// @rust-only
import { Effect } from "effect";

const items = new Map<string, number>([["a", 1], ["b", 2]]);
const visit = Effect.forEach(items, ([key, value], index) => Effect.gen(function* () {
  yield* Effect.sleep(1);
  if (key === "a") {
    items.delete("b");
    items.set("c", 3);
  }
  return `${index}:${key}:${value}`;
}));
console.log((await Effect.runPromise(visit)).join(","));
items.clear();
items.set("q", 7);
console.log((await Effect.runPromise(visit)).join(","));

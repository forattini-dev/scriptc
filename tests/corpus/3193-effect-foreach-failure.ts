// @rust-only
import { Effect } from "effect";

const items = new Map<string, number>([["a", 1], ["b", 2], ["c", 3]]);
const seen: string[] = [];
const visit = Effect.forEach(items, ([key, value]): Effect.Effect<number, string> => {
  seen.push(key);
  if (key === "b") return Effect.fail("stop");
  return Effect.succeed(value);
});
console.log(Effect.runSync(Effect.catch(visit, (error) => Effect.succeed([-error.length]))).join(","));
console.log(seen.join(","));
items.delete("a");
items.delete("b");
items.set("d", 4);
console.log(Effect.runSync(visit).join(","));
console.log(seen.join(","));

const outer = new Map<string, number>([["x", 1], ["y", 2]]);
Effect.runSync(Effect.forEach(outer, ([key]) => Effect.gen(function* () {
  yield* Effect.forEach(outer, ([inner]) => Effect.sync(() => {
    console.log(key, inner);
    if (key === "x" && inner === "x") {
      outer.delete("y");
      outer.set("z", 3);
    }
  }), { discard: true });
}), { discard: true }));

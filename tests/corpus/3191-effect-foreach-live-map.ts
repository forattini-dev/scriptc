// @rust-only
import { Effect } from "effect";

const files = new Map<string, number>([["a", 1], ["b", 2]]);
const input: ReadonlyMap<string, number> = files;
const visit = Effect.forEach(input, ([key, value], index) => Effect.gen(function* () {
  yield* Effect.sync(() => {
    if (key === "a") {
      files.delete("b");
      files.set("c", 3);
    }
  });
  return `${index}:${key}:${value}`;
}));
files.set("d", 4);
console.log(Effect.runSync(visit).join(","));
files.clear();
files.set("z", 9);
console.log(Effect.runSync(visit).join(","));

const seen: string[] = [];
Effect.runSync(Effect.forEach(files, ([key]) => Effect.sync(() => {
  seen.push(key);
  if (key === "z") {
    files.clear();
    files.set("q", 10);
  }
}), { discard: true }));
console.log(seen.join(","));

// @rust-only
import { Effect } from "effect";

const items = new Set<number>([1, 2]);
const visit = Effect.forEach(items, (item, index) => Effect.sync(() => {
  if (item === 1) {
    items.delete(2);
    items.add(3);
  }
  return `${index}:${item}`;
}));
items.add(4);
console.log(Effect.runSync(visit).join(","));
items.clear();
items.add(7);
console.log(Effect.runSync(visit).join(","));

let calls = 0;
Effect.runSync(Effect.forEach(items, () => Effect.sync(() => { calls++; }), { discard: true }));
Effect.runSync(Effect.forEach(new Map<string, number>(), () => Effect.sync(() => { calls++; }), { discard: true }));
console.log(calls);

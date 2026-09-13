// @rust-only
import { Effect } from "effect";

const items = [1, 2];
const visit = Effect.forEach(items, (item, index) => Effect.sync(() => {
  if (item === 1) {
    items[1] = 20;
    items.push(3);
  }
  return `${index}:${item}`;
}));
items.push(4);
console.log(Effect.runSync(visit).join(","));
items.length = 0;
items.push(7);
console.log(Effect.runSync(visit).join(","));

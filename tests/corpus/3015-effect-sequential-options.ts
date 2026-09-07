// @rust-only
import { Effect } from "effect";

const events: string[] = [];
const first = Effect.andThen(Effect.sleep(1), Effect.sync(() => {
  events.push("first");
  return 1;
}));
const second = Effect.sync(() => {
  events.push("second");
  return 2;
});
const values = await Effect.runPromise(Effect.all([first, second], { concurrency: 1, discard: false }));
console.log(values.join(","), events.join(","));

await Effect.runPromise(Effect.forEach([3, 4], (n) =>
  Effect.andThen(Effect.sleep(1), Effect.sync(() => { events.push(String(n)); })),
{ discard: true, concurrency: 1 }));
console.log(events.join(","));

const doubled = Effect.runSync(Effect.forEach([5, 6], (n) => Effect.succeed(n * 2), { discard: false, concurrency: 1 }));
console.log(doubled.join(","));
Effect.runSync(Effect.all([Effect.sync(() => { events.push("discarded"); })], { discard: true, concurrency: 1 }));
console.log(events.join(","));

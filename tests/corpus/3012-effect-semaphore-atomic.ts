// @rust-only
import { Deferred, Effect, Semaphore } from "effect";

const events: string[] = [];
const gate = Effect.runSync(Deferred.make<void>());
const permits = Semaphore.makeUnsafe(2);
const holder = Effect.runPromise(permits.withPermits(1)(
  Effect.andThen(Effect.sync(() => { events.push("holder"); }), Deferred.await(gate)),
));
// This waiter needs two permits. It must leave the available one free for
// the next operation, instead of taking half of its request and parking.
const large = Effect.runPromise(permits.withPermits(2)(
  Effect.sync(() => { events.push("large"); }),
));
const small = Effect.runPromise(permits.withPermits(1)(
  Effect.sync(() => { events.push("small"); }),
));
await Effect.runPromise(Deferred.succeed(gate, undefined));
await holder;
await large;
await small;
console.log(events.join(","));

const empty = Semaphore.makeUnsafe(0);
console.log(Effect.runSync(empty.withPermits(0)(Effect.succeed("zero"))));
const fractional = Semaphore.makeUnsafe(0.5);
console.log(Effect.runSync(fractional.withPermits(0.5)(Effect.succeed("fraction"))));
console.log(Effect.runSync(fractional.withPermits(0.5)(Effect.succeed("released"))));

console.log(await Effect.runPromise(Effect.catchCause(
  permits.withPermits(2)(Effect.die("failure")),
  () => Effect.succeed("defect released"),
)));
console.log(Effect.runSync(permits.withPermits(2)(Effect.succeed("all free"))));

// `withPermit(effect)` is the uncurried withPermits(1)(effect): one permit, released the same way.
console.log(Effect.runSync(permits.withPermit(Effect.succeed("single permit"))));
console.log(Effect.runSync(permits.withPermit(permits.withPermit(Effect.succeed("nested singles")))));
console.log(await Effect.runPromise(Effect.catchCause(
  permits.withPermit(Effect.die("single failure")),
  () => Effect.succeed("single released"),
)));
console.log(Effect.runSync(permits.withPermits(2)(Effect.succeed("both free after singles"))));

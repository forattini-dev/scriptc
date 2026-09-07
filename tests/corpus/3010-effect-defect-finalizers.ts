// @rust-only
import { Cause, Effect, SynchronizedRef } from "effect";

const events: string[] = [];
const cleanup = Effect.sync(() => { events.push("cleanup"); });
const describe = (effect: Effect.Effect<unknown, unknown>): Effect.Effect<string> =>
  Effect.catchCause(Effect.as(effect, "success"), (cause) =>
    Effect.succeed(`${Cause.hasDies(cause)}:${String(Cause.squash(cause))}`));

console.log(Effect.runSync(describe(Effect.ensuring(Effect.die("boom"), cleanup))));
console.log(events.join(","));

// Ordinary failure recovery must not intercept a defect.
console.log(Effect.runSync(describe(Effect.catch(Effect.die("still a defect"), (_error: string) => Effect.succeed("wrong")))));

// Throws in callbacks and rejected Effect.promise values are defects too.
console.log(Effect.runSync(describe(Effect.sync(() => { throw "thrown"; }))));
console.log(await Effect.runPromise(describe(Effect.promise(() => new Promise<string>((_resolve, reject) => reject(new Error("rejected")))))));

// A defect in an effectful update must release the write permit.
const cell = Effect.runSync(SynchronizedRef.make(1));
console.log(await Effect.runPromise(describe(SynchronizedRef.updateEffect(cell, () => Effect.die("update")))));
await Effect.runPromise(SynchronizedRef.set(cell, 2));
console.log(Effect.runSync(SynchronizedRef.get(cell)));

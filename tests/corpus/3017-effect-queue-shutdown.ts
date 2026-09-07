// @rust-only
import { Cause, Effect, Queue } from "effect";

const events: string[] = [];
const describe = (effect: Effect.Effect<number>): Effect.Effect<string> =>
  Effect.catchCause(Effect.map(effect, (n) => `value:${n}`), (cause) =>
    Effect.succeed(`${Cause.hasDies(cause)}:${Cause.hasInterrupts(cause)}:${Cause.hasInterruptsOnly(cause)}`));

const full = Effect.runSync(Queue.bounded<number>(1));
console.log(Effect.runSync(Queue.offer(full, 1)));
const offering = Effect.runPromise(Effect.ensuring(Queue.offer(full, 2), Effect.sync(() => { events.push("offer done"); })));
console.log(await Effect.runPromise(Queue.shutdown(full)));
console.log(await offering);
console.log(Effect.runSync(Queue.size(full)));
console.log(await Effect.runPromise(describe(Queue.take(full))));
console.log(Effect.runSync(Queue.offer(full, 3)));
console.log(Effect.runSync(Queue.shutdown(full)));

const empty = Effect.runSync(Queue.unbounded<number>());
const taking = Effect.runPromise(describe(Effect.ensuring(Queue.take(empty), Effect.sync(() => { events.push("take done"); }))));
await Effect.runPromise(Queue.shutdown(empty));
console.log(await taking);
console.log(events.join(","));

// Ordinary typed-error recovery must not swallow an interruption.
console.log(await Effect.runPromise(describe(Effect.catch(Queue.take(empty), (_error: unknown) => Effect.succeed(99)))));

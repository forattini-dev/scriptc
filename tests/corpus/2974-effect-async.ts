// @rust-only
// Asynchronous effects on the native kernel: Effect.promise suspends the
// fiber on the program's own promise, Effect.tryPromise turns a
// rejection into a typed failure, and gen bodies mix sync and async
// steps; runPromise settles when the fiber exits.
import { Effect } from "effect";

const wait = (ms: number, value: string): Promise<string> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

const fetched = Effect.promise(() => wait(5, "fetched"));

const flaky = (fail: boolean): Effect.Effect<string, string> =>
  Effect.tryPromise({
    try: () => new Promise<string>((resolve, reject) => (fail ? reject(new Error("network down")) : resolve("ok"))),
    catch: (reason) => `failed: ${reason instanceof Error ? reason.message : String(reason)}`,
  });

const program = Effect.gen(function* () {
  const first = yield* fetched;
  const second = yield* Effect.catch(flaky(true), (e) => Effect.succeed(e));
  const third = yield* flaky(false);
  const total = yield* Effect.sync(() => first.length + third.length);
  return `${first} | ${second} | ${third} | ${total}`;
});

console.log(await Effect.runPromise(program));
console.log(await Effect.runPromise(Effect.map(fetched, (s) => s.toUpperCase())));

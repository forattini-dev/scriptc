// @rust-only
// Scopes, finalizers and taps on the native kernel: scoped/addFinalizer
// run finalizers LIFO with the exit, ensuring and acquireRelease/
// acquireUseRelease release resources on any outcome, tap/tapError
// observe without changing the channel, suspend defers construction,
// sleep suspends the fiber, and Effect.exit captures an Exit handle.
import { Effect, Exit } from "effect";

const events: string[] = [];
const note = (text: string) => Effect.sync(() => { events.push(text); });
const drain = (): string => { const joined = events.join(" "); while (events.length > 0) events.pop(); return joined; };

const scoped = Effect.scoped(
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => note("fin-1"));
    yield* Effect.addFinalizer((exit) => note(`fin-2:${exit._tag}`));
    const handle = yield* Effect.acquireRelease(Effect.succeed("res"), (r, exit) => note(`release:${r}:${exit._tag}`));
    yield* note(`body:${handle}`);
    return handle.length;
  }),
);
console.log(Effect.runSync(scoped), drain());

const failing = Effect.scoped(
  Effect.gen(function* () {
    yield* Effect.addFinalizer((exit) => note(`fin:${exit._tag}`));
    yield* Effect.fail("boom");
    return 1;
  }),
);
console.log(Effect.runSync(Effect.catch(Effect.ensuring(failing, note("ensured")), (e) => Effect.succeed(e.length))), drain());

const used = Effect.acquireUseRelease(
  Effect.succeed(10),
  (n) => Effect.map(note(`use:${n}`), () => n * 2),
  (n, exit) => note(`close:${n}:${exit._tag}`),
);
console.log(Effect.runSync(used), drain());

const tapped = Effect.succeed(5).pipe(
  Effect.tap((n) => note(`saw:${n}`)),
  Effect.tap(() => note("again")),
  Effect.map((n) => n + 1),
);
const tappedError = Effect.fail("e1").pipe(Effect.tapError((e) => note(`err:${e}`)), Effect.catch((e) => Effect.succeed(e.length)));
console.log(Effect.runSync(tapped), Effect.runSync(tappedError), drain());

let built = 0;
const lazy = Effect.suspend(() => { built += 1; return Effect.succeed(built); });
console.log(Effect.runSync(lazy), Effect.runSync(lazy), built);

const exits = Effect.gen(function* () {
  const ok = yield* Effect.exit(Effect.succeed("fine"));
  const bad = yield* Effect.exit(Effect.fail("nope"));
  return `${Exit.isSuccess(ok)} ${Exit.isFailure(bad)} ${ok._tag} ${bad._tag} ${Exit.isSuccess(ok) ? ok.value : "?"}`;
});
console.log(Effect.runSync(exits));

const slept = Effect.gen(function* () {
  const before = Date.now();
  yield* Effect.sleep(15);
  yield* Effect.sleep("10 millis");
  return Date.now() - before >= 20;
});
console.log(await Effect.runPromise(slept));

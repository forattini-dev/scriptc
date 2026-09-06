// @rust-only
// Effect.gen bodies run as the kernel's own generators: `yield*` hands the
// kernel an effect and reads its value back typed; a failing yield* ends
// the body; catch/mapError/orDie shape the failure channel. Static
// build, no engine; the Node oracle runs the real effect package.
import { Effect } from "effect";

const program = Effect.gen(function* () {
  const a = yield* Effect.succeed(20);
  const b = yield* Effect.sync(() => 22);
  const parts: string[] = [];
  for (let i = 0; i < 3; i++) {
    const scaled = yield* Effect.succeed(i * (a + b));
    parts.push(String(scaled));
  }
  return `${a + b}:${parts.join(",")}`;
});
console.log(Effect.runSync(program));

const failing = Effect.gen(function* () {
  const n = yield* Effect.succeed(1);
  if (n === 1) yield* Effect.fail("boom");
  return "unreachable";
});
console.log(Effect.runSync(Effect.catch(failing, (e) => Effect.succeed(`recovered:${e}`))));

const relabeled = Effect.mapError(Effect.fail(7), (n) => `code-${n}`);
console.log(Effect.runSync(Effect.catch(relabeled, (e) => Effect.succeed(e))));

const nested = Effect.gen(function* () {
  const inner = yield* Effect.catch(failing, (e) => Effect.succeed(`${e}!`));
  const twice = yield* Effect.map(program, (s) => s.length * 2);
  return inner.length + twice;
});
console.log(await Effect.runPromise(Effect.orDie(nested)));

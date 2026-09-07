// @rust-only
import { Cause, Effect } from "effect";

console.log(JSON.stringify(Cause.squash(Cause.fail({ code: 42, message: "stored" }))));
console.log(JSON.stringify(Cause.squash(Cause.fail([1, 2, 3]))));

type Failure = { code: number } | string;
const record: Effect.Effect<number, Failure> = Effect.fail({ code: 7 });
const text: Effect.Effect<number, Failure> = Effect.fail("text");
const defect: Effect.Effect<number, Failure> = Effect.die("defect");
const describe = (effect: Effect.Effect<number, Failure>) =>
  Effect.catchCause(effect, (cause) => Effect.succeed(JSON.stringify(Cause.squash(cause))));
console.log(Effect.runSync(describe(record)));
console.log(Effect.runSync(describe(text)));
console.log(Effect.runSync(describe(defect)));

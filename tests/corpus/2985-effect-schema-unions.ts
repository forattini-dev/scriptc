// @rust-only
// Effect.fn over a plain function body, Schema.Union over a member array,
// toTaggedUnion as the union itself, and Duration math.
import { Duration, Effect, Schema } from "effect";

class Wrapped extends Schema.TaggedErrorClass<Wrapped>()("Wrapped", {
  message: Schema.String,
  reason: Schema.optional(Schema.String),
}) {}

const Created = Schema.Struct({ type: Schema.Literal("created"), id: Schema.String });
const Deleted = Schema.Struct({ type: Schema.Literal("deleted"), id: Schema.String, hard: Schema.Boolean });
const Definitions = [Created, Deleted];
const Event = Schema.Union(Definitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"));
const decode = Schema.decodeUnknownSync(Event);

const double = Effect.fn("double")((n: number) => Effect.succeed(n * 2));
const failing = Effect.fn("failing")((why: string) => Effect.fail(new Wrapped({ message: why, reason: "inner " + why })));

const program = Effect.gen(function* () {
  const a = yield* double(21);
  const b = yield* failing("nope").pipe(Effect.catchTag("Wrapped", (e) => Effect.succeed(`${e.message} <- ${e.reason ?? "?"}`)));
  return `${a} ${b}`;
});
console.log(Effect.runSync(program));

const e1 = decode(JSON.parse('{"type":"created","id":"c1"}'));
const e2 = decode(JSON.parse('{"type":"deleted","id":"d1","hard":true}'));
console.log(e1, e2, e2.type === "deleted" ? e2.hard : null);
try {
  decode(JSON.parse('{"type":"moved","id":"x"}'));
} catch (e) {
  console.log((e as Error).message);
}

const half = Duration.seconds(1.5);
console.log(Duration.toMillis(half), Duration.toSeconds(Duration.minutes(2)), Duration.toMillis(Duration.zero));
const w = new Wrapped({ message: "m" });
console.log(w.reason === undefined, w._tag, String(w));

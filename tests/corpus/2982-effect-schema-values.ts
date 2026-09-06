// @rust-only
// Schema values as native descriptors: primitives, Struct with optional
// fields, Array, Record, Union, Literal(s), NullOr, brand and check
// filters; decodeUnknownSync (success and effect's issue messages),
// decodeUnknownOption, decodeUnknownEffect (SchemaError in the failure
// channel), decodeUnknownExit, Schema.is, S.make, S.annotate, encodeSync.
import { Effect, Exit, Option, Schema } from "effect";

const Person = Schema.Struct({
  name: Schema.String,
  age: Schema.Number,
  tags: Schema.Array(Schema.String),
  kind: Schema.Literals(["admin", "user"]),
  nick: Schema.optional(Schema.String),
  scores: Schema.Record(Schema.String, Schema.Number),
  ref: Schema.Union([Schema.String, Schema.Number]),
  flag: Schema.NullOr(Schema.Boolean),
}).annotate({ identifier: "Person" });
type Person = typeof Person.Type;

const ID = Schema.String.pipe(Schema.brand("ID"));
const Positive = Schema.Number.check(Schema.isGreaterThanOrEqualTo(1));
const Prefixed = Schema.String.check(Schema.isStartsWith("ab"));
const A = Schema.Struct({ kind: Schema.Literal("a"), x: Schema.Number });
const B = Schema.Struct({ kind: Schema.Literal("b"), y: Schema.String });
const AB = Schema.Union([A, B]);

const decodePerson = Schema.decodeUnknownSync(Person);
// (Optional keys are given: an absent optional key prints as `undefined` in a compiled record — a pre-existing
// record-inspect divergence, not the decoder's.)
const good: unknown = JSON.parse('{"name":"ana","age":31,"tags":["x","y"],"kind":"admin","nick":"an","scores":{"m":1.5},"ref":7,"flag":null,"extra":true}');
const person = decodePerson(good);
console.log(person);
console.log(person.name.toUpperCase(), person.age + 1, person.tags.length, person.nick === "an", person.ref, person.flag);

const bad: unknown[] = [
  5,
  JSON.parse('{"name":"x"}'),
  JSON.parse('{"name":"x","age":"1","tags":[],"kind":"admin","scores":{},"ref":1,"flag":null}'),
  JSON.parse('{"name":"x","age":1,"tags":["t",2],"kind":"admin","scores":{},"ref":1,"flag":null}'),
  JSON.parse('{"name":"x","age":1,"tags":[],"kind":"boss","scores":{},"ref":1,"flag":null}'),
  JSON.parse('{"name":"x","age":1,"tags":[],"kind":"user","scores":{"k":"v"},"ref":1,"flag":null}'),
  JSON.parse('{"name":"x","age":1,"tags":[],"kind":"user","scores":{},"ref":true,"flag":null}'),
  JSON.parse('{"name":"x","age":1,"tags":[],"kind":"user","scores":{},"ref":1,"flag":1}'),
  null,
];
for (const input of bad) {
  try {
    decodePerson(input);
    console.log("unexpected success");
  } catch (e) {
    console.log("error:", (e as Error).message);
  }
}

console.log(Schema.decodeUnknownSync(ID)("abc"), Schema.decodeUnknownSync(Positive)(3), Schema.decodeUnknownSync(Prefixed)("abz"));
const attempts: { label: string; run: () => unknown }[] = [
  { label: "positive", run: () => Schema.decodeUnknownSync(Positive)(0) },
  { label: "prefixed", run: () => Schema.decodeUnknownSync(Prefixed)("zz") },
  { label: "int", run: () => Schema.decodeUnknownSync(Schema.Int)(1.5) },
  { label: "finite", run: () => Schema.decodeUnknownSync(Schema.Finite)(Infinity) },
  { label: "literal", run: () => Schema.decodeUnknownSync(Schema.Literal("a"))("b") },
  { label: "union structs", run: () => Schema.decodeUnknownSync(AB)(JSON.parse('{"kind":"c"}')) },
  { label: "union member", run: () => Schema.decodeUnknownSync(AB)(JSON.parse('{"kind":"a"}')) },
  { label: "array", run: () => Schema.decodeUnknownSync(Schema.Array(A))(JSON.parse('[{"kind":"a","x":1},{"kind":"a"}]')) },
  { label: "boolean", run: () => Schema.decodeUnknownSync(Schema.Boolean)("true") },
];
for (const attempt of attempts) {
  try {
    attempt.run();
    console.log(attempt.label, "ok");
  } catch (e) {
    console.log(attempt.label + ":", (e as Error).message);
  }
}

const maybe = Schema.decodeUnknownOption(A);
const some = maybe(JSON.parse('{"kind":"a","x":2}'));
console.log(Option.isSome(some), Option.isSome(maybe(JSON.parse('{"kind":"b"}'))));
if (Option.isSome(some)) console.log(some.value.x * 10, some.value.kind);

console.log(Schema.is(Person)(good), Schema.is(Person)(5));

const viaEffect = Schema.decodeUnknownEffect(B);
const r1 = Effect.runSync(viaEffect(JSON.parse('{"kind":"b","y":"yes"}')).pipe(Effect.map((b) => b.y.length)));
const r2 = Effect.runSync(viaEffect(JSON.parse('{"kind":"b","y":3}')).pipe(Effect.map((b) => b.y.length), Effect.catch((e) => Effect.succeed(e.message.length))));
const r3 = Effect.runSync(viaEffect(5).pipe(Effect.map((b) => b.y), Effect.catch((e) => Effect.succeed(`${e._tag}: ${e.message}`))));
console.log(r1, r2, r3);

const exit = Schema.decodeUnknownExit(Schema.Number)("no");
console.log(Exit.isFailure(exit), Exit.isSuccess(Schema.decodeUnknownExit(Schema.Number)(4)));

const made = Person.make({ name: "bo", age: 2, tags: [], kind: "user", nick: "b", scores: { a: 1 }, ref: "r", flag: true });
console.log(made, Schema.encodeSync(A)({ kind: "a", x: 9 }));

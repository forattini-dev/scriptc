// @rust-only
// Effect.try over a throwing thunk, orElseSucceed, catchIf with a typed
// predicate, and Option as an opaque handle: some/none, isSome/isNone,
// getOrUndefined, getOrElse, map, match, `_tag` and `value`.
import { Effect, Option } from "effect";

const parse = (text: string) =>
  Effect.try({
    try: () => { if (text === "") throw new Error("empty"); return text.length; },
    catch: (reason) => `bad:${reason instanceof Error ? reason.message : String(reason)}`,
  });
console.log(Effect.runSync(parse("four")), Effect.runSync(Effect.catch(parse(""), (e) => Effect.succeed(e.length))));
console.log(Effect.runSync(Effect.orElseSucceed(parse(""), () => -1)));

const picky = Effect.fail("retry-me").pipe(
  Effect.catchIf((e) => e.startsWith("retry"), () => Effect.succeed("recovered")),
);
const strict = Effect.fail("fatal").pipe(
  Effect.catchIf((e) => e.startsWith("retry"), () => Effect.succeed("recovered")),
  Effect.catch((e) => Effect.succeed(`still:${e}`)),
);
console.log(Effect.runSync(picky), Effect.runSync(strict));

const present = Option.some(21);
const absent = Option.none<number>();
console.log(Option.isSome(present), Option.isNone(present), Option.isSome(absent), Option.isNone(absent));
console.log(present._tag, absent._tag, Option.isSome(present) ? present.value * 2 : 0);
const shown = (o: Option.Option<number>): string => `${Option.getOrUndefined(o) ?? "none"}|${Option.getOrElse(o, () => -1)}`;
console.log(shown(present), shown(absent));
const doubled = Option.map(present, (n) => n * 2);
console.log(Option.match(doubled, { onNone: () => "no", onSome: (n) => `yes:${n}` }), Option.match(absent, { onNone: () => "no", onSome: (n) => `yes:${n}` }));
const named = Option.some("ana").pipe(Option.map((s) => s.toUpperCase()));
console.log(Option.getOrElse(named, () => "?"));

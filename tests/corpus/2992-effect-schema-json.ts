// @rust-only
// `Schema.fromJsonString` (JSON text in, the decoded value out), `Schema.UnknownFromJsonString` and `Schema.Tuple`.
import { Effect, Option, Schema } from "effect";

const Registration = Schema.Struct({ port: Schema.Number, host: Schema.String });
const decodeRegistration = Schema.decodeUnknownSync(Schema.fromJsonString(Registration));
const parsed = decodeRegistration('{"port":4000,"host":"local"}');
console.log(parsed.port + 1, parsed.host);

try {
  decodeRegistration('{"port":"4000","host":"local"}');
} catch (e) {
  console.log((e as Error).message);
}

const Pair = Schema.Tuple([Schema.String, Schema.Number]);
const decodePair = Schema.decodeUnknownSync(Pair);
console.log(decodePair(JSON.parse('["a",2]')));
try {
  decodePair(JSON.parse('["a"]'));
} catch (e) {
  console.log((e as Error).message);
}

// A JSON-text schema whose payload has a shape decodes through the same wrap.
const Flag = Schema.fromJsonString(Schema.Struct({ ok: Schema.Boolean }));
const decodeFlag = Schema.decodeUnknownOption(Flag);
const flag = Option.getOrUndefined(decodeFlag('{"ok":true}'));
console.log(flag !== undefined ? JSON.stringify(flag) : "none");
console.log(Effect.runSync(Effect.succeed(Option.isSome(decodeFlag("not json")))));

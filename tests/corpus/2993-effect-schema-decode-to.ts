// @rust-only
// `Schema.decodeTo`: a transforming schema — decode the source, run the program's transform, decode the target.
import { Schema, SchemaGetter } from "effect";

const QueryBoolean = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value: boolean) => (value ? "true" : "false")),
  }),
);

const decodeFlag = Schema.decodeUnknownSync(QueryBoolean);
console.log(decodeFlag("true"), decodeFlag("false"));
try {
  decodeFlag("maybe");
} catch (e) {
  console.log((e as Error).message);
}

const Doubled = Schema.Number.pipe(
  Schema.decodeTo(Schema.Int, {
    decode: SchemaGetter.transform((n) => n * 2),
    encode: SchemaGetter.transform((n: number) => n / 2),
  }),
);
const decodeDoubled = Schema.decodeUnknownSync(Doubled);
console.log(decodeDoubled(21));
console.log(decodeDoubled(0.5));
try {
  decodeDoubled(0.3);
} catch (e) {
  console.log((e as Error).message);
}

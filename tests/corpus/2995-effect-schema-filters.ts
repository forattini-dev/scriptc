// @rust-only
// `Schema.isPattern` and `Schema.isBetween`, over the runtime's own regex engine and range check.
import { Schema } from "effect";

const Slug = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z]+$/)));
const decodeSlug = Schema.decodeUnknownSync(Slug);
console.log(decodeSlug("abc"));
try {
  decodeSlug("A1");
} catch (e) {
  console.log((e as Error).message);
}

const Small = Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 })));
const decodeSmall = Schema.decodeUnknownSync(Small);
console.log(decodeSmall(3), decodeSmall(1), decodeSmall(5));
try {
  decodeSmall(9);
} catch (e) {
  console.log((e as Error).message);
}

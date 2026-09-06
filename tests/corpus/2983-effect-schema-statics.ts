// @rust-only
// Decorated schemas (a schema value with program statics — redcode's
// `statics` idiom over Object.assign), program functions as pipe steps,
// Schema.tag with S.make defaults, and make() on a schema class.
import { Schema } from "effect";

const statics =
  <S extends object, M extends Record<string, unknown>>(methods: (schema: S) => M) =>
  (schema: S): S & M =>
    Object.assign(schema, methods(schema));

let counter = 0;
const EventID = Schema.String.check(Schema.isStartsWith("evt_")).pipe(
  Schema.brand("Event.ID"),
  statics((schema) => ({ create: () => schema.make("evt_" + String(++counter)), prefix: "evt_" })),
);
type EventID = typeof EventID.Type;

const Created = Schema.Struct({
  _tag: Schema.tag("Created"),
  id: EventID,
  at: Schema.Number,
});

class Info extends Schema.Class<Info>("Info")({ id: EventID, label: Schema.String }) {
  describe(): string {
    return `${this.label}@${this.id}`;
  }
}

const first: EventID = EventID.create();
const second = EventID.create();
console.log(first, second, EventID.prefix, first.startsWith(EventID.prefix));

const created = Created.make({ id: first, at: 3 });
console.log(created, created._tag === "Created", created.at * 2);

const decode = Schema.decodeUnknownSync(Created);
console.log(decode(JSON.parse('{"_tag":"Created","id":"evt_9","at":1}')));
for (const raw of ['{"id":"evt_9","at":1}', '{"_tag":"Other","id":"evt_9","at":1}', '{"_tag":"Created","id":"nope","at":1}']) {
  try {
    decode(JSON.parse(raw));
  } catch (e) {
    console.log((e as Error).message);
  }
}

const info = Info.make({ id: second, label: "two" });
console.log(info, info.describe(), info instanceof Info);
console.log(Schema.decodeUnknownSync(EventID)("evt_x"), Schema.is(EventID)("bad"));

// @rust-only
// @no-engine
interface Event {
  collection: string;
  bytes?: number;
  [key: string]: unknown;
}
function box(event: Event): unknown { return event; }
function unbox(event: unknown): Event { return event as Event; }
const event: Event = { collection: "events", bytes: 1 };
const dynamic = box(event);
const alias = unbox(dynamic);
console.log("identity", event === alias, alias === unbox(dynamic));
event.bytes = 2;
console.log("source write", alias.bytes);
alias.bytes = 3;
alias.extra = "new";
console.log("alias write", event.bytes, event.extra as string);
const events = [event];
const byName = new Map<string, Event>();
byName.set("event", event);
const fromMap = byName.get("event")!;
console.log("containers", events[0] === event, fromMap === event);
event.self = event;
console.log("cycle", unbox(alias.self) === event);
function bag(value: unknown): Record<string, unknown> { return value as Record<string, unknown>; }
delete bag(dynamic).self;
console.log("json", JSON.stringify(event));
const absent: Event = { collection: "absent" };
const explicit: Event = { collection: "explicit", bytes: undefined };
console.log("optional keys", Object.keys(bag(box(absent))).join(","), Object.keys(bag(box(explicit))).join(","));
const parsed = JSON.parse('{"collection":"parsed","bytes":4,"extra":"kept"}') as Event;
const parsedAlias = unbox(box(parsed));
parsedAlias.bytes = 5;
console.log("parsed", parsedAlias === parsed, parsed.bytes, parsed.extra as string);
const fixed = { count: 8 };
const fixedDynamic: unknown = fixed;
const fixedAlias = fixedDynamic as { count: number };
const copied = { ...fixed };
console.log("spread", fixedAlias === fixed, copied === fixed, copied.count);
copied.count = 99;
console.log("spread write", fixed.count);
const clone = structuredClone(event);
clone.bytes = 100;
console.log("clone", clone === event, event.bytes, clone.bytes);
function abandonCycle(): void {
  const value: Event = { collection: "cycle" };
  value.self = value;
  const alias = unbox(box(value));
  console.log("local cycle", unbox(alias.self) === value);
  try { JSON.stringify(alias); }
  catch (error) { console.log("circular", error instanceof TypeError); }
}
abandonCycle();
export {};

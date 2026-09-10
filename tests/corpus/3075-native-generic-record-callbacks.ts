// @no-engine
interface ValueSpec { kind: "value"; coerce: (raw: string) => unknown }
type Spec = ValueSpec | { kind: "boolean" };
let calls = 0;
function inspect<T extends Record<string, Spec>>(schema: T): void {
  for (const [name, spec] of Object.entries(schema)) {
    if (spec.kind === "boolean") console.log(name, "boolean");
    else {
      console.log(name, spec.coerce("2"));
      const values = ["3", "4"].map(item => spec.coerce(item));
      for (const value of values) console.log("mapped", value);
    }
  }
}
inspect({ json: { kind: "boolean" }, count: { kind: "value", coerce: (raw: string) => { calls++; return Number(raw); } } });
inspect({
  json: { kind: "boolean" },
  text: { kind: "value", coerce: (raw: string) => { calls++; return "v" + raw; } },
  count: { kind: "value", coerce: (raw: string) => { calls++; return raw === "3" ? undefined : Number(raw); } },
});
console.log("calls", calls);

let events = "";
const original = (raw: string): number => { events += "C"; return Number(raw) + 10; };
const replacement = (raw: string): number => { events += "N"; return Number(raw) + 20; };
const mutable = { kind: "value" as const, coerce: original };
function observe<T>(value: T): T { events += "R"; return value; }
function replace(): string { events += "A"; mutable.coerce = replacement; return "2"; }
function invoke<T extends Record<string, Spec>>(schema: T): void {
  for (const [name, spec] of Object.entries(schema)) {
    if (spec.kind !== "boolean") {
      console.log(name, observe(spec).coerce(replace()));
      console.log("next", spec.coerce("2"));
    }
  }
}
invoke({ json: { kind: "boolean" }, mutable });
console.log("order", events, mutable.coerce === replacement);

function failArgument(): string { events += "A"; throw new Error("argument"); }
function failReceiver<T>(value: T): T { events += "R"; throw new Error("receiver"); }
function failures<T extends Record<string, Spec>>(schema: T): void {
  for (const [, spec] of Object.entries(schema)) {
    if (spec.kind !== "boolean") {
      try { console.log(observe(spec).coerce(failArgument())); }
      catch (error) { console.log("argument", error instanceof Error, events); }
      try { console.log(failReceiver(spec).coerce(replace())); }
      catch (error) { console.log("receiver", error instanceof Error, events); }
      try { console.log(spec.coerce("bad")); }
      catch (error) { console.log("callback", error instanceof Error, events); }
    }
  }
}
events = "";
failures({ json: { kind: "boolean" }, bad: { kind: "value", coerce: (raw: string): number => { events += raw; throw new Error("callback"); } } });

interface Payload { count: number }
type PayloadSpec = { kind: "value"; coerce: (raw: string) => Payload } | { kind: "boolean" };
const payload: Payload = { count: 1 };
function readPayload<T extends Record<string, PayloadSpec>>(schema: T): void {
  for (const [, spec] of Object.entries(schema)) {
    if (spec.kind !== "boolean") {
      const value = spec.coerce("2");
      console.log("identity", value === payload);
      value.count++;
    }
  }
}
readPayload({
  json: { kind: "boolean" },
  first: { kind: "value", marker: 1, coerce: (raw: string): Payload => payload },
  second: { kind: "value", other: true, coerce: (raw: string): Payload => payload },
});
console.log("payload", payload.count);

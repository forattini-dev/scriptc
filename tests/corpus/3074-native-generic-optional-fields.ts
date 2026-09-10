// @no-engine
interface ValueSpec {
  kind: "value";
  type?: "array";
  coerce: (raw: string) => unknown;
}
type Spec = ValueSpec | { kind: "boolean" };
let reads = 0;
function observe<T>(value: T): T { reads++; return value; }
function inspect<T extends Record<string, Spec>>(schema: T): void {
  for (const [name, spec] of Object.entries(schema)) {
    if (spec.kind === "boolean") console.log(name, "boolean");
    else {
      console.log("direct", spec.type === "array", spec.type === undefined);
      const mode = observe(spec).type;
      console.log(name, mode === undefined ? "scalar" : mode, "reads", reads);
    }
  }
}
inspect({ json: { kind: "boolean" }, count: { kind: "value", coerce: (raw: string) => Number(raw) } });
inspect({
  json: { kind: "boolean" },
  tags: { kind: "value", type: "array", coerce: (raw: string) => raw },
  count: { kind: "value", coerce: (raw: string) => Number(raw) },
});
const mutable: ValueSpec = { kind: "value", coerce: (raw: string) => raw };
inspect({ json: { kind: "boolean" }, mutable });
mutable.type = "array";
inspect({ json: { kind: "boolean" }, mutable });
mutable.type = undefined;
inspect({ json: { kind: "boolean" }, mutable });

function fail<T>(value: T): T { reads++; throw new Error("receiver failed"); }
function thrownRead<T extends Record<string, Spec>>(schema: T): void {
  for (const [, spec] of Object.entries(schema)) {
    if (spec.kind !== "boolean") {
      try { console.log(fail(spec).type); }
      catch (error) { console.log("caught", error instanceof Error, "reads", reads); }
    }
  }
}
thrownRead({ json: { kind: "boolean" }, count: { kind: "value", coerce: (raw: string) => Number(raw) } });

interface Payload { count: number }
type PayloadSpec = { kind: "value"; payload?: Payload } | { kind: "boolean" };
function inspectPayload<T extends Record<string, PayloadSpec>>(schema: T, original: Payload): void {
  for (const [name, spec] of Object.entries(schema)) {
    if (spec.kind !== "boolean") {
      const payload = spec.payload;
      if (payload !== undefined) {
        console.log("payload", name, payload === original);
        payload.count++;
      } else console.log("payload", name, "absent");
    }
  }
}
const payload: Payload = { count: 10 };
inspectPayload({ json: { kind: "boolean" }, present: { kind: "value", payload }, absent: { kind: "value" } }, payload);
console.log("original", payload.count);

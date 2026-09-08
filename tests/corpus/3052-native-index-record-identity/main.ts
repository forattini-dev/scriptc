// @rust-only
// @no-engine
import { state as staticState } from "./module.ts";
// A type boundary must not clone a JavaScript object.
type Bag = Record<string, unknown>;
function box(value: Bag): unknown { return value; }
function unbox(value: unknown): Bag { return value as Bag; }

const original: Bag = { count: 1, label: "first" };
const dynamic = box(original);
const view = unbox(dynamic);
console.log("identity", original === view, view === unbox(dynamic));
original.count = 2;
console.log("source write", view.count as number);
view.count = 3;
view.extra = "added";
console.log("view write", original.count as number, original.extra as string);
delete view.label;
console.log("keys", Object.keys(original).join(","));

const child: Bag = { value: 4 };
original.child = child;
const nested = unbox(view.child);
console.log("nested identity", child === nested);
nested.value = 5;
console.log("nested write", child.value as number);

original.self = original;
console.log("cycle identity", unbox(view.self) === original);
delete original.self;
const copy: Bag = { ...original };
console.log("spread identity", copy === original, unbox(copy.child) === child);
copy.count = 9;
console.log("spread write", original.count as number, copy.count as number);

const parsed: unknown = JSON.parse('{"value":10}');
const parsedView = unbox(parsed);
parsedView.value = 11;
console.log("parsed write", unbox(parsed).value as number);
console.log("json", JSON.stringify(original));
function abandonCycle(): void {
  const cycle: Bag = {};
  cycle.self = cycle;
  const boxed = box(cycle);
  console.log("abandoned cycle", unbox(unbox(boxed).self) === cycle);
  try { JSON.stringify(cycle); }
  catch (error) { console.log("cycle serialization", error instanceof TypeError); }
}
abandonCycle();
const cloned = structuredClone(original);
console.log("clone identity", cloned === original, unbox(cloned.child) === child);
unbox(cloned.child).value = 99;
console.log("clone write", child.value as number);

async function nativeBoundary(): Promise<void> {
  const ns = await import("./module.ts");
  const exported = unbox(ns.state);
  console.log("export identity", exported === staticState, ns.state === ns.state);
  console.log("direct read", ns.state.count as number);
  console.log("export aliases", ns.state === ns.aliasState, unbox(ns.default) === exported);
  ns.bump();
  console.log("export write", exported.count as number);
  exported.count = 42;
  console.log("import write", ns.currentCount());
  ns.replace();
  console.log("export rebound", unbox(ns.state) === staticState, exported === staticState);
  console.log("default snapshot", unbox(ns.default) === exported, ns.aliasState === ns.state);
  console.log("export values", exported.count as number, staticState.count as number);
  const record: Bag = { count: 20 };
  console.log("native identity", unbox(ns.echo(record)) === record);
  console.log("native mutation", await ns.increment(record), record.count as number);
}
nativeBoundary();
export {};

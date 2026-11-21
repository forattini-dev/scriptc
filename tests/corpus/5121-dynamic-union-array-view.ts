type Narrow = { kind: "a"; value: string } | { kind: "b"; count: number };
type Wide = { kind: "a"; value: string; extra: boolean } | { kind: "b"; count: number; extra: boolean };
const original: Wide[] = [{ kind: "a", value: "first", extra: true }, { kind: "b", count: 42, extra: false }];
const erased: any = original;
const view: Narrow[] = erased;
console.log((original as any) === (view as any));
const first = view[0];
if (first.kind === "a") {
  console.log(first.value);
  first.value = "changed";
}
const observed = original[0];
if (observed.kind === "a") console.log(observed.value);
const second = view[1];
if (second.kind === "b") console.log(second.count);
view[1] = second;
const retained = original[1];
if (retained.kind === "b") console.log(retained.extra);
const externalSource: { kind: "b"; count: number; extra: boolean; source: string } = { kind: "b", count: 7, extra: false, source: "dynamic" };
const external: any = externalSource;
const fromDynamic: Narrow[] = [external];
const item = fromDynamic[0];
if (item.kind === "b") console.log(item.count);

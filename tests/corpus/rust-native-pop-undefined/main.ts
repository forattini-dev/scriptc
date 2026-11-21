// @rust-only
// @no-engine
function observe(values: any[]): void {
  console.log("pop", String(values.pop()), "length", values.length);
}
const values: any[] = ["ok", undefined];
observe(values);
observe(values);
observe(values);
const holes: any[] = ["first"];
holes.length = 3;
observe(holes);
observe(holes);
observe(holes);
const shared = { value: 1 };
const references: any[] = [shared];
const popped = references.pop();
popped.value = 4;
console.log("identity", shared.value);
const mixed: (number | string | null)[] = [1, "two", null];
console.log("mixed", String(mixed.pop()), String(mixed.pop()), String(mixed.pop()), String(mixed.pop()));
mixed.length = 1;
console.log("mixed hole", String(mixed.pop()), mixed.length);
const record = { value: 7 };
const recordUnion: ({ value: number } | number)[] = [record, 2];
console.log("record union number", String(recordUnion.pop()));
const recordResult: any = recordUnion.pop();
recordResult.value = 11;
console.log("record union identity", record.value, String(recordUnion.pop()));
const optional: (number | undefined)[] = [undefined, 4];
console.log("optional", String(optional.pop()), String(optional.pop()), String(optional.pop()));
optional.length = 2;
console.log("optional holes", String(optional.pop()), optional.length);

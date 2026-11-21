// @ts-nocheck
const record: { value: number; computed?: number } = { value: 4 };
const alias = record;
Object.defineProperty(record, "computed", {
  get() { return this === alias ? this.value + 3 : 0; },
  enumerable: true,
  configurable: true,
});
console.log("record", String(record.computed), String(alias.computed));
console.log("keys", Object.keys(record).join(","));

// @rust-only
// @no-engine
function normalize(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value;
}
const date = new Date('2026-01-02T03:04:05.006Z');
const alias = date;
const copy = new Date(date);
console.log(date === alias, date === copy, date.getTime() === copy.getTime());
const unknownDate: unknown = date;
console.log(normalize(unknownDate), normalize(42), normalize(null));
console.log(unknownDate === date, unknownDate === copy);
const extracted = unknownDate as Date;
console.log(extracted === date, extracted.getUTCFullYear(), Boolean(unknownDate), typeof unknownDate);
const object: unknown = { date, invalid: new Date(NaN) };
console.log(JSON.stringify(object));
function replacer(key: string, value: unknown): unknown {
  console.log('visit', key, typeof value, value instanceof Date);
  return value;
}
console.log(JSON.stringify(object, replacer));
const cloned: unknown = structuredClone(unknownDate);
console.log(cloned === unknownDate, normalize(cloned));

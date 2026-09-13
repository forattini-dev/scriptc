// @rust-only
// @no-engine
const date = new Date(0);
const another = new Date(0);
const dates: Date[] = [date, another, date];
console.log(dates[0] === date, dates[0] === dates[1], dates.includes(date), dates.indexOf(another));
const boxed: unknown = { first: date, second: date };
const copied = structuredClone(boxed) as { first: Date; second: Date };
console.log(copied.first === copied.second, copied.first === date, copied.first.getTime());
const view = boxed as { first: Date; second: Date };
console.log(view.first === date, view.second === date);
view.first = new Date(123);
console.log(view.first.getTime(), view.second.getTime());
function fromUnknown(value: unknown): number {
  const time = value as Date | number;
  return typeof time === 'number' ? time : time.getTime();
}
console.log(fromUnknown(date), fromUnknown(42));
const optional: Date | undefined = date;
const erased: unknown = optional;
const restored = erased as Date | undefined;
console.log(restored === date);

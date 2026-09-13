// @rust-only
// @no-engine
import { Effect } from 'effect';
const date = new Date(123);
const copied = Effect.runSync(Effect.map(Effect.succeed(date), value => new Date(value)));
console.log(copied === date, copied.getTime());
function convert(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value;
}
const operation = Effect.map(Effect.succeed(date as Date | number), convert);
console.log(Effect.runSync(operation));
async function echo(value: Date): Promise<Date> { return value; }
console.log((await echo(date)) === date);
function* dates(): Generator<Date, void, unknown> { yield date; yield copied; }
for (const value of dates()) console.log(value === date, value.getTime());

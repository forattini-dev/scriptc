// @rust-only
// @no-engine
import { Effect } from 'effect';

function cycle(): void {
  const record: { value: number; task: unknown } = { value: 1, task: undefined };
  const task = Effect.succeed(record);
  record.task = task;
  const first = Effect.runSync(task);
  first.value = 7;
  const second = Effect.runSync(task);
  console.log('payload', first === second, second.value, second.task === task);
}
cycle();

function union(value: number | string | null | undefined): void {
  const task = Effect.succeed(value);
  console.log('union', Effect.runSync(task), Effect.runSync(task));
}
union(4);
union('text');
union(null);
union(undefined);
const empty = Effect.succeed(null);
console.log('null', Effect.runSync(empty) === null);
const integer: Effect.Effect<unknown> = Effect.succeed(9007199254740993n);
console.log('bigint', typeof Effect.runSync(integer), Effect.runSync(integer));
const date = new Date(123);
const dateTask: Effect.Effect<unknown> = Effect.succeed(date);
console.log('date', Effect.runSync(dateTask) === date);

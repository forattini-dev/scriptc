// @rust-only
// @no-engine
import { Effect } from 'effect';
function same(left: unknown, right: unknown): boolean { return left === right; }
let executions = 0;
const original = Effect.sync(() => { executions++; return 'value'; });
const transport: unknown = original;
const restored = transport as Effect.Effect<string>;
console.log('direct', restored === original, transport === original);
const methods = new Map<string, (value: Effect.Effect<string>, ...args: unknown[]) => Effect.Effect<string>>();
methods.set('identity', (value: Effect.Effect<string>, ...args: unknown[]) => {
  console.log('args', args.length);
  return value;
});
const identity = methods.get('identity');
if (identity !== undefined) {
  console.log('same', same(identity(restored, 1, 2), original), executions);
  console.log('inline', Effect.runSync(identity(original)), executions);
}
const array: Effect.Effect<string>[] = [original];
const box: unknown = array;
const values = box as Effect.Effect<string>[];
console.log('array', same(values[0], original));
values.push(Effect.succeed('next'));
console.log('shared', array.length, Effect.runSync(array[1]!));
const record: { task: Effect.Effect<string> } = { task: original };
const boxedRecord: unknown = record;
const alias = boxedRecord as { task: Effect.Effect<string> };
alias.task = Effect.succeed('replacement');
console.log('record', Effect.runSync(record.task), same(alias.task, record.task));
function optional(value: unknown): string {
  const task = value as Effect.Effect<string> | undefined;
  return task === undefined ? 'missing' : Effect.runSync(task);
}
console.log('optional', optional(undefined), optional(original), executions);
function cycle(): void {
  let slot: unknown;
  const task = Effect.sync(() => slot);
  slot = task;
  console.log('cycle', Effect.runSync(task) === slot);
}
cycle();

try { throw original; } catch (error) {
  console.log('thrown', same(error, original));
  const recovered = error as Effect.Effect<string>;
  console.log(Effect.runSync(recovered), executions);
}

const nested: Effect.Effect<unknown> = Effect.succeed(original);
console.log('nested', same(Effect.runSync(nested), original));

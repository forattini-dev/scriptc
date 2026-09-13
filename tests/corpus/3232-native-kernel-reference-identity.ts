// @rust-only
// @no-engine
import { Context, Duration, Effect, Exit, Layer, Option, Schema } from 'effect';

function same(left: unknown, right: unknown): boolean { return left === right; }
function kind(value: unknown): string { return typeof value; }
console.log('constants', same(Effect.void, Effect.void), same(Option.none(), Option.none()), same(Layer.empty, Layer.empty));
console.log('fresh', same(Effect.succeed(7), Effect.succeed(7)), same(Option.some(7), Option.some(7)), same(Exit.succeed(7), Exit.succeed(7)));
console.log('duration', same(Duration.zero, Duration.zero), same(Duration.zero, Duration.millis(0)), same(Duration.millis(0), Duration.millis(0)));
console.log('schema', same(Schema.String, Schema.String), same(Schema.String, Schema.Number), same(Schema.Defect(), Schema.Defect()));
console.log('json schema', same(Schema.UnknownFromJsonString, Schema.UnknownFromJsonString), same(Schema.UnknownFromJsonString, Schema.fromJsonString(Schema.Unknown)));
class First extends Context.Service<First, { value: number }>()('same-key') {}
class Second extends Context.Service<Second, { value: number }>()('same-key') {}
console.log('services', same(First, First), same(First, Second));
console.log('types', kind(First), kind(Effect.void), kind(Option.none()), kind(Schema.String));
const key: unknown = First;
console.log('tests', typeof key === 'function', typeof key === 'object');
console.log('lookup', Effect.runSync(Effect.provideService(First, Second, { value: 7 })).value);

const exited: unknown = Exit.succeed(9);
console.log('exit', Effect.runSync(exited as Effect.Effect<number>));
const failed: unknown = Exit.fail('failure');
console.log('failure', Effect.runSync(Effect.catch(failed as Effect.Effect<number, string>, error => Effect.succeed(error))));

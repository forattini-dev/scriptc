// @rust-only
// @no-engine
import { Effect } from 'effect';
const cache = new Map<string, (...args: unknown[]) => Effect.Effect<string>>();
let executions = 0;
cache.set('work', (...args: unknown[]) => Effect.sync(() => {
  executions++;
  return args.map(value => String(value)).join(':');
}));
const work = cache.get('work');
if (work !== undefined) {
  const program = work('a', 2);
  console.log('created', executions);
  console.log(Effect.runSync(program), executions);
  console.log(Effect.runSync(program), executions);
}

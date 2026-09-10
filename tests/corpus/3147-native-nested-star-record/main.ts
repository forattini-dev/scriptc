// @rust-only
// @no-engine
import { state, bump, replaceNested } from './leaf.ts';
async function main(): Promise<void> {
  const barrel = await import('./barrel.ts');
  const leaf = await import('./leaf.ts');
  const again = await import('./barrel.ts');
  const held = barrel.state;
  const inner = held.nested;
  console.log('identity', barrel === again, held === leaf.state, held === state, inner === state.nested);
  barrel.state.nested.count = 4;
  bump();
  console.log('writes', state.nested.count, leaf.state.nested.count, inner.count);
  replaceNested();
  console.log('replacement', barrel.state === state, barrel.state.nested === state.nested, inner !== state.nested, inner.count, barrel.state.nested.count);
  barrel.state.nested.count = 12;
  console.log('retained', held.nested.count, leaf.state.nested.count);
}
main();

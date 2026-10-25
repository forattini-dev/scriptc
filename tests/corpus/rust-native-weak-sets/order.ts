// @rust-only
// @no-engine
// @ts-nocheck
let trace = '';
const key = { id: 1 };
const later = { id: 2 };
const seed = [key];
function input(): { id: number }[] { trace = trace + 'i'; return seed; }
function extra(): number { trace = trace + 'e'; seed.push(later); return 3; }
const set = new WeakSet(input(), extra());
console.log('constructor', trace, set.has(key), set.has(later));
trace = '';
function receiver(): WeakSet<{ id: number }> { trace = trace + 'r'; return set; }
function value(): { id: number } { trace = trace + 'k'; return key; }
function ignored(): void { trace = trace + 'e'; }
console.log('call', receiver().add(value(), ignored()) === set, trace);
trace = '';
function invalid(): number { trace = trace + 'p'; return 1; }
try { receiver().add(invalid(), ignored()); } catch (e) { console.log('invalid', (e as Error).name, (e as Error).message, trace); }
trace = '';
function fail(): number { trace = trace + 'x'; throw new Error('extra'); }
try { set.add(1, fail()); } catch (e) { console.log('extra', (e as Error).message, trace); }
console.log('missing', set.has(), set.delete());
try { set.add(); } catch (e) { console.log('missing add', (e as Error).message); }
function invalidKey(value: unknown): void {
  console.log('query', set.has(value), set.delete(value));
  try { set.add(value); } catch (e) { console.log('add error', (e as Error).name, (e as Error).message); }
}
invalidKey(null); invalidKey(undefined); invalidKey(1); invalidKey(false); invalidKey('key');
try { new WeakSet([key, 1, later]); } catch (e) { console.log('seed error', (e as Error).message); }
export {};

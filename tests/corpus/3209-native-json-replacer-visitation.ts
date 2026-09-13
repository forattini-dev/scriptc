// @rust-only
// @no-engine
const source: Record<string, unknown> = { '10': 10, '2': 2, first: 1, later: 4 };
let trace = '';
function visit(this: unknown, key: string, value: unknown): unknown {
  trace += key + ':';
  if (key === '') console.log('root-holder', this !== source);
  if (key === 'first') { source.later = 8; source.added = 9; }
  if (key === '2') return undefined;
  return value;
}
console.log(JSON.stringify(source, visit, 2));
console.log(trace);
const values: unknown[] = [1, 2, 3];
function shrink(key: string, value: unknown): unknown {
  if (key === '0') values.pop();
  return value;
}
console.log(JSON.stringify(values, shrink));
let hookTrace = '';
const hooked: unknown = {
  child: { toJSON(key: string): unknown { hookTrace += 'hook:' + key + ';'; return 17n; } },
};
function convert(key: string, value: unknown): unknown {
  hookTrace += 'replace:' + key + ';';
  return typeof value === 'bigint' ? value.toString() : value;
}
console.log(JSON.stringify(hooked, convert), hookTrace);
const circular: Record<string, unknown> = {};
circular.self = circular;
function identity(_key: string, value: unknown): unknown { return value; }
try { console.log(JSON.stringify(circular, identity)); }
catch (error) { if (error instanceof Error) console.log(error.name, error.message); }
function prune(key: string, value: unknown): unknown { return key === 'self' ? undefined : value; }
console.log(JSON.stringify(circular, prune));
function fail(_key: string, _value: unknown): unknown { throw new Error('callback failed'); }
try { console.log(JSON.stringify(3, fail)); }
catch (error) { if (error instanceof Error) console.log(error.name, error.message); }
console.log(JSON.stringify({ after: true }, identity));
console.log(JSON.stringify({ unused: 1n }, () => 42));
console.log(JSON.stringify({ unused: 1n }, () => undefined));

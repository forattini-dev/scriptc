// @rust-only
// @no-engine
const events: string[] = [];
const values: unknown[] = [1, 2];
function mark(label: string): string {
  events.push(label);
  return label;
}
function source(): unknown[] {
  events.push('spread');
  return values;
}
function mutate(): string {
  values[0] = 9;
  events.push('mutate');
  return 'tail';
}
function collect(prefix: string, ...args: unknown[]): string {
  events.push('call');
  const result = prefix + args.map(value => String(value)).join('|');
  args[0] = 'local';
  return result;
}
console.log(collect(mark('prefix:'), mark('first'), ...source(), mutate(), ...values));
console.log(events.join(','), values.map(value => String(value)).join(','));
console.log(collect('', ...values), collect('', ...values));
console.log(collect('', ...'A😀B'));
const cached = new Map<string, (prefix: string, ...args: unknown[]) => string>();
cached.set('collect', collect);
const fn = cached.get('collect');
if (fn !== undefined) {
  console.log(fn('cached:', ...values, 'end'));
  console.log(fn('empty:'));
  console.log(fn === cached.get('collect'));
}

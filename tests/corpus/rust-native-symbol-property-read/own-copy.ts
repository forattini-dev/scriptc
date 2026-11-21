// @rust-only
// @no-engine
const first = Symbol('same');
const second = Symbol('same');
const input: any = { label: 'first' };
input[first] = 'a';
input[second] = 'b';
const spread: any = { ...input, label: 'spread' };
const assigned: any = Object.assign({ label: 'target' }, input);
console.log('values', spread[first] as string, spread[second] as string, spread.label as string);
console.log('assign', assigned[first] as string, assigned[second] as string, assigned.label as string);
input[first] = 'changed';
console.log('independent', spread[first] as string, assigned[first] as string, input[first] as string);
const wide: { label: string } = input;
const typed = { ...wide, label: 'typed' };
const view: any = typed;
console.log('typed', view[first] as string, view[second] as string, typed.label);
const other: any = {};
other[first] = 'last';
const stacked: any = { ...input, ...other };
console.log('overwrite', stacked[first] as string, stacked[second] as string);
const cycle: any = {};
cycle[first] = cycle;
const cycleCopy: any = { ...cycle };
console.log('cycle', cycleCopy[first] === cycle);

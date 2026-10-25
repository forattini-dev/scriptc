// @rust-only
// @no-engine
// @ts-nocheck
const keys = ['a', 'b'];
const frame: { index: number; keys: string[] | null } = { index: 0, keys };
const allowed = new Set<string>(['a', 'b']);
while (frame.index < frame.keys.length) { const key = frame.keys[frame.index++]; if (!allowed.has(key)) continue; console.log('key', key); }
console.log('frame', frame.index, frame.keys['length']);
let calls = 0;
const numbers = [1, 2];
const words = ['x'];
function choose(flag: boolean): number[] | string[] | null { calls++; if (flag) return numbers; return words; }
console.log('union', choose(true).length, choose(false)['length'], calls);
const empty: number[] = [];
function maybeEmpty(): number[] | undefined { return empty; }
console.log('empty', maybeEmpty().length, maybeEmpty()['length']);
console.log('ordinary', numbers.length, numbers['length']);
const alias = frame.keys;
keys.push('c');
console.log('alias', alias.length, frame.keys.length);

function seed(): string[] | null { return keys; }
const first = seed()[0];
const captured = (): string | undefined => first;
const missing = seed()[99];
console.log('lookup-storage', first, captured(), missing);

const setArray = [new Set<string>(['a'])];
function owningElements(): Set<string>[] | null { return setArray; }
console.log('typed-elements', owningElements().length);

const recordGroups: Record<string, { name: string }[]> = { active: [{ name: 'guarded' }] };
const recordGroup = recordGroups['active'];
if (recordGroup !== undefined) console.log('guarded-record-array', recordGroup.length, recordGroup[0].name);

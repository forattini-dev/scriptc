// @rust-only
// @no-engine
function merge(source: any): any { return Object.assign({ first: 'target', value: 1 }, source); }
const source: any = { value: 2, other: 'yes' };
const result: any = merge(source);
console.log('copy', result.first as string, result.value as number, result.other as string, Object.keys(result).join(','));
source.value = 3;
console.log('separate', result.value as number, source.value as number);
const empty: any = merge(null);
console.log('null', empty.first as string, empty.value as number, Object.keys(empty).join(','));
let events = '';
function mark(): string { events += 'target'; return 'made'; }
function readSource(): any { events += ',source'; return { extra: 'copied' }; }
function ordered(): any { return Object.assign({ first: mark() }, readSource()); }
const checked: any = ordered();
console.log('order', events, checked.first as string, checked.extra as string);

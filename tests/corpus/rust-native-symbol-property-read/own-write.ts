// @rust-only
// @no-engine
const first = Symbol('same');
const second = Symbol('same');
const object: any = { name: 'object' };
const alias: any = object;
object[first] = 'first';
alias[second] = 'second';
console.log('identity', object === alias, object[first] as string, alias[second] as string);
object[first] = 'changed';
console.log('changed', alias[first] as string, object[second] as string, Object.keys(object).join(','));
function label(this: any): string { return this.name as string; }
object[second] = label;
console.log('receiver', object[second]() as string);
let evaluations = 0;
function getObject(): any { evaluations++; return object; }
console.log('receiver once', getObject()[second]() as string, evaluations);
const cycle: any = {};
cycle[first] = cycle;
console.log('cycle', cycle[first] === cycle);
const nil: any = null;
try { nil[first] = 'never'; } catch (error: any) { console.log('null', error.message as string); }

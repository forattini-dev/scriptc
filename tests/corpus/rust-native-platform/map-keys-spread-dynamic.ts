// @rust-only
// @no-engine
const typed = new Map<any, any>([['first', 1], ['second', 2]]);
const map: any = typed;
let count = 0;
function receiver(): any { count++; return map; }
function later(): string { typed.set('third', 3); return 'last'; }
const keys: any[] = ['start', ...receiver().keys(), later()];
console.log('order', keys.join(','), count);
console.log('later', [...map.keys()].join(','));
const nullable: any = null;
try { [...nullable.keys()]; } catch (error: any) { console.log('null', error instanceof TypeError); }

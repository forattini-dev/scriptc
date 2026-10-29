// @rust-only
// @no-engine
function build(common: any): any { return { id: 'fixed', count: 1, ...common, tail: 7 }; }
const common = { id: 'override', other: 2 };
const result: any = build(common);
console.log('fields', result.id === 'override', result.count === 1, result.other === 2, result.tail === 7);
console.log('keys', Object.keys(result).join(','));
console.log('nullish', build(null).id === 'fixed', build(undefined).count === 1);
const str: any = build('ab');
console.log('string', str['0'] === 'a', str['1'] === 'b');
let trace = '';
function source(): any { trace += 's'; return { id: 'spread' }; }
function finish(): number { trace += 't'; return 9; }
const order: any = { id: 'before', ...source(), tail: finish() };
console.log('order', order.id === 'spread', order.tail === 9, trace);

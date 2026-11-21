// @rust-only
// @no-engine
const first = Symbol('same');
const second = Symbol('same');
const object: any = { name: 'kept', '3': 'three' };
object[first] = 'first';
object[second] = 'second';
let order = '';
function receiver(): any { order += 'r'; return object; }
function symbolKey(): any { order += 'k'; return first; }
console.log('delete symbol', delete receiver()[symbolKey()], order, first in object, second in object);
const numberKey: any = 3;
console.log('delete number', delete object[numberKey], Object.keys(object).join(','));
const missing: any = 'missing';
console.log('delete missing', delete object[missing], object[second] as string);
const nil: any = null;
try { delete nil[symbolKey()]; } catch (error: any) { console.log('null', error instanceof TypeError); }

// @no-engine
let trace = '';
function convert(value) { return Number(value); }
function parse(value, radix) { return Number.parseInt(value, radix); }
function globalParse(value, radix) { return parseInt(value, radix); }
const numeric = { valueOf() { trace += 'valueOf;'; return 7; }, toString() { trace += 'toString;'; return '12'; } };
console.log(convert(numeric), trace);
trace = '';
console.log(parse(numeric, 10), trace);
const fallback = { valueOf() { trace += 'object;'; return {}; }, toString() { trace += 'fallback;'; return '23'; } };
trace = ''; console.log(convert(fallback), trace);
function argument() { trace += 'argument;'; return numeric; }
function radixArgument() { trace += 'radixArgument;'; return { valueOf() { trace += 'radixValueOf;'; return 10; } }; }
trace = ''; console.log(parse(argument(), radixArgument()), trace);
trace = ''; console.log(globalParse(argument(), radixArgument()), trace);
const bad = { valueOf() { return {}; }, toString() { return {}; } };
try { console.log(convert(bad)); } catch (error) { console.log(String(error)); }
const failing = { valueOf() { trace += 'throw;'; throw new Error('numeric hook'); } };
trace = ''; try { convert(failing); } catch (error) { console.log(String(error), trace); }
const nullish = { valueOf() { return null; } };
const boolean = { valueOf() { return true; } };
console.log(convert(nullish), convert(boolean));
trace = ''; console.log(Number.parseInt(argument(), radixArgument()), trace);
trace = ''; console.log(parseInt(argument(), radixArgument()), trace);
// The plain-function form already supports dynamic this; shorthand object
// methods retain the compiler's separately tested SC1090 receiver fence.
function receiverValueOf() { this.count += 1; return this.count; }
const receiver = { count: 0, valueOf: receiverValueOf };
console.log(convert(receiver), receiver.count, convert(receiver), receiver.count);
const ownNonCallable = { valueOf: 7, toString() { return '31'; } };
console.log(convert(ownNonCallable));
const noPrototype = Object.create(null);
try { console.log(convert(noPrototype)); } catch (error) { console.log(String(error)); }
const listElement = { toString() { trace += 'element;'; return '17'; } };
trace = ''; console.log(convert([listElement]), trace);
const cycle = JSON.parse('[]');
cycle.push(cycle);
console.log(convert(cycle));
cycle.pop();
const mutable = JSON.parse('[0,2]');
mutable[0] = { toString() { mutable.pop(); return '1'; } };
console.log(convert(mutable));
mutable.pop();

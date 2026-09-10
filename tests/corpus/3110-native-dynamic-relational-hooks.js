// @no-engine
let trace = '';
function value(label, answer) {
  trace += 'eval-' + label + ';';
  return { valueOf() { trace += 'primitive-' + label + ';'; return answer; } };
}
function compare(left, right) { return [left < right, left <= right, left > right, left >= right]; }
console.log(JSON.stringify(compare('2', '10')));
trace = ''; console.log(value('left', '2') < value('right', '10'), trace);
trace = ''; console.log(value('left', '2') > value('right', '10'), trace);
trace = ''; console.log(value('left', 2) <= value('right', '10'), trace);
trace = ''; console.log(value('left', undefined) >= value('right', null), trace);
const fallback = { valueOf() { trace += 'valueOf;'; return {}; }, toString() { trace += 'toString;'; return '3'; } };
trace = ''; console.log(JSON.stringify(compare(fallback, '20')), trace);
function throwPrimitive() { trace += 'throw;'; throw new Error('comparison'); }
const failure = { valueOf: throwPrimitive };
trace = ''; try { console.log(failure < value('right', 2)); } catch (error) { console.log(String(error), trace); }
const cycle = JSON.parse('[]'); cycle.push(cycle);
console.log(JSON.stringify(compare(cycle, '0'))); cycle.pop();
const rightFailure = { valueOf() { trace += 'right-throw;'; throw new Error('right comparison'); } };
trace = ''; try { console.log(value('left', 'string') > rightFailure); } catch (error) { console.log(String(error), trace); }
trace = ''; console.log(value('left', NaN) <= value('right', 3), trace);
const noPrimitive = { valueOf: 0, toString: 0 };
try { console.log(JSON.stringify(compare(noPrimitive, 1))); } catch (error) { console.log(String(error)); }
const receiver = { answer: '20', valueOf: function () { return this.answer; } };
console.log(JSON.stringify(compare(receiver, '3')));

// Dynamic Object.defineProperty accessor descriptors retain their explicit runtime refusal.
function copy(value) { return Buffer.from(value).toString('hex'); }
const record = JSON.parse('{"1":2}');
let trace = '';
Object.defineProperty(record, 'valueOf', { get() {
  trace += 'v';
  return function () { trace += 'c'; return record; };
} });
Object.defineProperty(record, 'length', { get() { trace += 'l'; return 2; } });
Object.defineProperty(record, '0', { get() { trace += '0'; record[1] = 9; return 257; } });
console.log(copy(record), trace);
const growing = JSON.parse('{}');
let reads = 0;
Object.defineProperty(growing, 'length', { get() { reads++; return reads < 4 ? 1 : 2; } });
try { copy(growing); } catch (error) { console.log(error.name, error.message, reads); }

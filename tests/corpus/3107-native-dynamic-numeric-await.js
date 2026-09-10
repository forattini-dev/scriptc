// @no-engine
let trace = '';
async function load(name, value) {
  trace += name + ';';
  await Promise.resolve(0);
  return value;
}
const source = { toString() { trace += 'sourceString;'; return '12'; } };
const radix = { valueOf() { trace += 'radixNumber;'; return 10; } };
console.log(Number.parseInt(await load('source', source), await load('radix', radix)), trace);
trace = '';
console.log(parseInt(await load('source', source), await load('radix', radix)), trace);
trace = '';
console.log(Number(await load('number', null)), trace);
trace = '';
try {
  const failing = { valueOf() { throw new Error('async number'); } };
  console.log(Number(await load('failing', failing)));
} catch (error) { console.log(String(error), trace); }
function absent() { trace += 'absent;'; }
trace = '';
console.log(Number.parseInt(source, absent()), trace);
trace = '';
console.log(Number.parseInt(source, undefined), trace);
async function catchBoundary() {
  try {
    console.log(Number(await load('boundary', '4')));
  } catch (error) { console.log('wrong inner catch', String(error)); }
  console.log('after inner try');
  throw new Error('outside try');
}
try { await catchBoundary(); }
catch (error) { console.log('outer catch', String(error)); }
function laterArgument(shouldThrow) { if (shouldThrow) throw new Error('later argument'); return 0; }
try { console.log(await load('before throw', 1), laterArgument(true)); }
catch (error) { console.log('later caught', String(error)); }
export {};

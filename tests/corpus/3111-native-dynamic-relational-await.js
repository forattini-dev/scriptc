// @no-engine
let trace = '';
async function load(label, answer) {
  trace += 'eval-' + label + ';';
  await Promise.resolve(0);
  return answer;
}
function value(label, answer) {
  return { valueOf() { trace += 'primitive-' + label + ';'; return answer; } };
}
console.log((await load('left', value('left', '2'))) < (await load('right', value('right', '10'))), trace);
trace = ''; console.log((await load('left', value('left', '2'))) > (await load('right', value('right', '10'))), trace);
trace = ''; console.log((await load('left', value('left', 2))) <= (await load('right', value('right', '10'))), trace);
trace = ''; console.log((await load('left', value('left', undefined))) >= (await load('right', value('right', 10))), trace);
const failure = { valueOf() { trace += 'throw;'; throw new Error('comparison'); } };
trace = '';
try { console.log(failure < (await load('right', value('right', 2)))); }
catch (error) { console.log(String(error), trace); }
trace = '';
try { console.log((await load('left', value('left', '2'))) > failure); }
catch (error) { console.log(String(error), trace); }
async function boundary() {
  try { console.log((await load('boundary', value('boundary', '2'))) < '3'); }
  catch (error) { console.log('wrong catch', String(error)); }
  throw new Error('outside comparison try');
}
try { await boundary(); } catch (error) { console.log('outer catch', String(error)); }
export {};

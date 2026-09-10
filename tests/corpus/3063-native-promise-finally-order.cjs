// @no-engine
'use strict';
// Compare reaction order, cleanup adoption and pass-through against Node.
function id(value) { return value; }
async function ready(value) { return value; }
async function failure() { throw new Error('source'); }
async function cleanupFailure() { throw new Error('cleanup'); }
const source = id(ready(7));
source.then(() => { console.log('adopting'); return source; })
  .then(value => console.log('adopted', value));
source.finally(() => { console.log('scalar cleanup'); return 42; })
  .then(value => console.log('scalar kept', value));
source.finally(() => { console.log('promise cleanup'); return ready(99); })
  .then(value => console.log('promise kept', value));
source.finally(null).then(value => console.log('noncallable kept', value));
id(failure()).finally(() => undefined)
  .catch(error => console.log('rejection kept', error.message));
source.finally(() => { throw new Error('thrown cleanup'); })
  .catch(error => console.log('thrown', error.message));
source.finally(() => cleanupFailure())
  .catch(error => console.log('replaced', error.message));
let cycle;
cycle = source.finally(() => cycle);
cycle.then(() => console.log('wrong cycle fulfilled'), () => console.log('wrong cycle rejected'));
source.then(() => console.log('tick 1'))
  .then(() => console.log('tick 2'))
  .then(() => console.log('tick 3'))
  .then(() => console.log('tick 4'))
  .then(() => console.log('tick 5'));
console.log('sync');

async function pendingCleanup(reject) {
  await ready(0);
  console.log('pending cleanup', reject);
  if (reject) throw new Error('pending cleanup');
  return 99;
}
source.finally(() => pendingCleanup(false))
  .then(value => console.log('pending kept', value));
id(failure()).finally(() => pendingCleanup(false))
  .catch(error => console.log('pending rejection kept', error.message));
source.finally(() => pendingCleanup(true))
  .catch(error => console.log('pending replaced', error.message));

// Promises CROSS the checked-dynamic tree (SCR_DYN_PROMISE): a typed
// promise boxes by reference when it flows through an untyped wrapper
// (promise<dyn> directly, other inners through the emitted settle
// adapter), typeof/String()/JSON.stringify answer Node's object forms,
// identity is the promise (=== across two crossings of one value), and
// .then/.catch/.finally on a DYN receiver run as microtask reactions with
// handler-result adoption and rejection passthrough.
'use strict';

function id(v) { return v; } // dyn in, dyn out — the crossing

async function seven() { return 7; }

const p = seven();
const boxedOnce = id(p);
// One box travelling through dyn space keeps its identity (=== is the
// promise, not the crossing). A SECOND boxing of the same typed promise
// mints a fresh adapter (SEMANTICS.md divergence), so the fixture pins
// the dyn-space identity only.
console.log(typeof boxedOnce, String(boxedOnce), JSON.stringify({ p: boxedOnce }));
console.log('same value:', id(boxedOnce) === id(boxedOnce));

// .then on the dyn receiver: the settled value arrives as a dyn value,
// the handler's return feeds the chained promise, and a returned promise
// is ADOPTED before the next link runs.
boxedOnce
  .then((v) => { console.log('then', v); return v + 1; })
  .then((v) => { console.log('chained', v); return seven(); })
  .then((v) => { console.log('adopted', v); });

// .catch and .finally: rejections pass through value handlers, the catch
// handler sees the thrown value, and finally observes without changing
// the settlement.
async function fails() { throw new Error('boom'); }
id(fails())
  .then(() => { console.log('unreachable'); })
  .catch((e) => { console.log('caught', String(e)); return 'recovered'; })
  .finally(() => { console.log('finally ran'); })
  .then((v) => { console.log('after finally', v); });

// The second then handler handles a rejection; a handler throw rejects the
// chained promise and remains catchable.
id(fails())
  .then(undefined, (e) => { console.log('then rejected', e.message); return 'handled'; })
  .then((v) => { console.log('then recovered', v); });
id(seven())
  .then(() => { throw new Error('handler boom'); })
  .catch((e) => { console.log('handler caught', e.message); });

// A promise returned by finally is awaited. Fulfillment preserves the source
// outcome, while cleanup rejection replaces it.
async function cleanup() { return 'clean'; }
async function cleanupFails() { throw new Error('cleanup boom'); }
id(seven())
  .finally(() => cleanup())
  .then((v) => { console.log('finally kept', v); });
id(fails())
  .finally(() => cleanup())
  .catch((e) => { console.log('finally kept rejection', e.message); });
id(seven())
  .finally(() => cleanupFails())
  .catch((e) => { console.log('finally replaced', e.message); });

console.log('sync tail');

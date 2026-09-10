// @no-engine
// JSDoc index signatures over dynamic JS globals retain missing-key values
// for dot/bracket guards, defaults, and comparisons, including read effects.
'use strict';

/** @type {Record<string, string>} */
const strings = { present: 'value', empty: '' };
console.log('missing', strings.missing === undefined, undefined === strings.missing,
  strings.missing !== undefined, strings['missing'] === undefined);
console.log('present', strings.present === undefined, strings.present !== undefined,
  strings.present === strings['present']);
console.log('defaults', strings.missing ?? 'nullish', strings.missing || 'falsy', !strings.missing);
console.log('empty', strings.empty ?? 'nullish', strings.empty || 'falsy', strings.empty === undefined);

/** @type {Record<string, { value: string }>} */
const objects = { present: { value: 'value' } };
console.log('objects', objects.missing === undefined, objects['missing'] === undefined,
  objects.present === objects['present']);

let reads = 0;
console.log('receiver', (reads++, strings).missing === undefined, reads);
function missingKey() { reads++; return 'missing'; }
console.log('key', strings[missingKey()] === undefined, reads);
console.log('negation', !(reads++, strings).missing, !strings[missingKey()], reads);

function nativeGuards() {
  /** @type {Record<string, string>} */
  const local = {};
  /** @type {string[]} */
  const values = [];
  console.log('native', !local.missing, !local['missing'], !values[0]);
}
nativeGuards();

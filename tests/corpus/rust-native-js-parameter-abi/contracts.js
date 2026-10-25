// @rust-only
// @no-engine
// @ts-nocheck
/** @param {string} key */
  function named(key) { console.log('named', key === undefined, key); }
function run() {
  const entries = { keys: ['a'], index: 0 };
  /** @returns {string[] | null} */
  const keys = () => entries.keys;
  /** @param {string} key */
  const observe = (key) => console.log('key', key === undefined, key);
  observe('first');
  const present = keys()[0];
  const absent = keys()[9];
  observe(present);
  observe(absent);
  /** @type {Record<string, string>} */
  const table = { present: 'value' };
  const unknown = table['missing'];
  observe(unknown);
  observe();
  const alias = observe;
  alias(undefined);
  let selected = observe;
  selected = (key) => console.log('assigned', key === undefined, key);
  selected(undefined);
  named('value'); named(absent);
  /** @param {string | number | undefined} value */
  const existingOptional = (value) => { if (typeof value === 'string') console.log('optional-view', value.slice(0, 2)); else console.log('optional-view', value === undefined); };
  existingOptional('abcd'); existingOptional(undefined);
}
run();

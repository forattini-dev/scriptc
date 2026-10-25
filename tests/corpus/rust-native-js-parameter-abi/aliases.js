// @rust-only
// @no-engine
// @ts-nocheck
function run() {
  /** @param {string} key */
  const sink = (key) => { if (key !== undefined) console.log('guard', key.trim()); const saved = key; const report = () => console.log('captured', saved === undefined, saved); report(); };
  /** @param {string} key */
  const middle = (key) => sink(key);
  /** @param {string} key */
  const first = (key) => { const value = key; middle(value); };
  first('start');
  const alias = first; const another = alias;
  another(undefined);
  first('end');
  /** @param {number} value */
  const number = (value) => console.log('number', value === undefined, value);
  /** @param {boolean} value */
  const boolean = (value) => console.log('boolean', value === undefined, value);
  number(undefined); number(2); boolean(false); boolean(undefined);
}
run();

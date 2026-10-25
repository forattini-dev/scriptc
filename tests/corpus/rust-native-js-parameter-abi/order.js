// @rust-only
// @no-engine
// @ts-nocheck
let trace = '';
function run() {
  /** @param {string} key @param {number} value */
  const observe = (key, value) => { trace = trace + 'C'; console.log('received', key === undefined, value); };
  /** @returns {string | undefined} */
  const missing = () => { trace = trace + 'K'; return undefined; };
  const later = () => { trace = trace + 'V'; return 2; };
  observe(missing(), later());
  console.log('order', trace);
  /** @returns {string | undefined} */
  const fail = () => { trace = trace + 'X'; throw new Error('argument'); };
  try { observe(fail(), later()); } catch (error) { if (error instanceof Error) console.log('abrupt', error.message, trace); else throw error; }
  observe('present', 3);
}
run();

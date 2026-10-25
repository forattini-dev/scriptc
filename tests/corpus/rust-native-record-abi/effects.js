// @rust-only
// @no-engine
// @ts-nocheck
let trace = '';
function run() {
  const frames = [{ key: 'seed', value: 0 }];
  /** @returns {string | undefined} */
  const key = () => { trace = trace + 'K'; return undefined; };
  const value = () => { trace = trace + 'V'; return 1; };
  const receiver = () => { trace = trace + 'R'; return frames; };
  frames.push({ key: key(), value: value() });
  console.log('order', trace, frames[1].key === undefined);
  /** @returns {string | undefined} */
  const fail = () => { trace = trace + 'X'; throw new Error('key'); };
  try { receiver().push({ key: fail(), value: value() }); }
  catch (error) { if (error instanceof Error) console.log('abrupt', trace, frames.length, error.message); else throw error; }
}
run();

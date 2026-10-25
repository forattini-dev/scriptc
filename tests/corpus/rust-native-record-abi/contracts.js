// @rust-only
// @no-engine
// @ts-nocheck
function run() {
  /** @returns {string[] | null} */
  const keys = () => ['a'];
  const frames = [{ key: 'root', count: 0 }];
  const missing = keys()[9];
  frames.push({ key: missing, count: 1 });
  frames.push({ count: 2 });
  const frame = frames[1];
  console.log('stored', frames[0].key, frame.key === undefined, frame.key, frame['key']);
  console.log('presence', Object.keys(frame).join(','), Object.keys(frames[2]).join(','));
  const copied = frame.key;
  /** @param {string} key */
  const report = (key) => console.log('argument', key === undefined, key);
  report(copied); report(frame.key); report('defined');
  frame.key = 'changed';
  console.log('write', frames[1].key);
  const clear = () => { frame.key = missing; };
  clear();
  console.log('cleared', frame.key === undefined);
  const counters = [{ n: 1, ok: true }];
  /** @returns {number | undefined} */
  const n = () => undefined;
  /** @returns {boolean | undefined} */
  const ok = () => undefined;
  counters.push({ n: n(), ok: ok() });
  console.log('primitives', counters[0].n, counters[0].ok, counters[1].n === undefined, counters[1].ok === undefined);
}
run();

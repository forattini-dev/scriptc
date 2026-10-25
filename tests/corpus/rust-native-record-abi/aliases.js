// @rust-only
// @no-engine
// @ts-nocheck
function run() {
  /** @returns {string[] | null} */
  const keys = () => ['a'];
  const seed = { key: 'first', count: 0 };
  const rows = [seed];
  const second = [seed];
  const shared = rows;
  const key = keys()[8];
  const next = { key, count: 1 };
  shared.push(next);
  const alias = next;
  const read = () => console.log('captured', alias.key === undefined, alias.key, rows[1] === alias);
  read();
  alias.key = 'changed';
  read();
  console.log('owners', rows[0] === second[0], second[0] === seed, rows[1].key);
  second.push({ key, count: 2 });
  console.log('shared-source', second[1].key === undefined, seed.key);
}
run();

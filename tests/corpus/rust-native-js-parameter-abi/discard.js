// @ts-nocheck
function choose(flag) {
  /** @type {Record<string, number>} */
  const values = { present: 6 };
  const selected = values['missing'];
  console.log('selected', selected === undefined, selected);
  return selected;
}
choose(true);
(choose(false));
console.log('continued');
function fail(flag) {
  if (flag) throw new Error('from callback');
  return 5;
}
try { fail(true); } catch (error) { if (error instanceof Error) console.log('throw', error.message); }


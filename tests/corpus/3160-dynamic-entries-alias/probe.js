/** @returns {any} */
function mint() {
  return { payload: { count: 1 }, scalar: 7 };
}

/** @param {object} bag */
function probe(bag) {
  const entries = Object.entries(bag);
  const outerAlias = entries;
  const pair = entries[0];
  const pairAlias = outerAlias[0];
  console.log(entries === outerAlias, pair === pairAlias);
  console.log(pair[0], pair[1] === bag.payload);
  pair[0] = "renamed";
  console.log(pairAlias[0], Object.keys(bag).join(","));
  const payload = pair[1];
  payload.count = 9;
  console.log(bag.payload.count, pairAlias[1] === payload);
  const [key, value] = pair;
  console.log(key, value === payload, value.count);
  const [first] = entries;
  first[0] = "again";
  console.log(pair[0], outerAlias[0][0]);
  console.log(entries[1][0], entries[1][1]);
}

export function run() {
  const bag = mint();
  probe(bag);
  console.log(`${bag.payload.count}`);
}

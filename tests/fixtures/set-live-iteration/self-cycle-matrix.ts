for (let round = 0; round < 32; round++) {
  const set = new Set<any>();
  set.add(set);
  const alias = set as Set<unknown>;
  const own = set.has(set);
  const same = alias.has(set);
  const size = alias.size;
  const removed = round % 2 === 0 ? alias.delete(set) : false;
  console.log(round, own, same, size, removed, set.size);
}

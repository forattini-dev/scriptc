function* visit(values: Set<number>): Generator<number, void, unknown> {
  for (const value of values) {
    yield value;
    if (value === 1) { values.delete(2); values.add(3); }
  }
}
const values = new Set([1, 2]);
const iterator = visit(values);
console.log(JSON.stringify(iterator.next()), JSON.stringify(iterator.next()), JSON.stringify(iterator.next()));

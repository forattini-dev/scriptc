const map = new Map<string, number>([['a', 1], ['b', 2]]);
function* iterate() {
  for (const value of map.values()) {
    yield value;
    if (value === 1) { map.delete('b'); map.set('c', 3); }
  }
}
const iterator = iterate();
console.log(JSON.stringify(iterator.next()));
console.log(JSON.stringify(iterator.next()));
console.log(JSON.stringify(iterator.next()));

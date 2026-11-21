export {};
const map = new Map<string, number>([['a', 1], ['b', 2]]);
const receiver = { tag: 'context' };
const seen: string[] = [];
map.forEach(function (this: { tag: string }, value, key, current) {
  seen.push(`${this.tag}:${key}:${value}:${current === map}`);
  if (key === 'a') {
    map.delete('b');
    map.set('c', 3);
    map.set('a', 9);
  }
}, receiver);
console.log(seen.join(','));
console.log('map', map.get('a'), map.has('b'), map.get('c'));

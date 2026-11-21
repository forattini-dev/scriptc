const map = new Map<string, number>([['a', 1], ['b', 2]]);
let evaluations = 0;
function receiver() { evaluations++; return map; }
const output: string[] = [];
for (const outer of receiver().values()) {
  for (const inner of map.values()) {
    output.push(String(outer) + ':' + String(inner));
    if (outer === 1 && inner === 1) map.delete('b');
    if (outer === 1 && inner === 1) map.set('c', 3);
  }
}
console.log(evaluations, output.join(','));

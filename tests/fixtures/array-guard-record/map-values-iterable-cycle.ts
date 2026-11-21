function retain(it: any, map: Map<string, any>): void {
  map.set('cycle', it);
  console.log(it.next().value === map.get('item'));
}
function make(): void {
  const item = { value: 7 };
  const map = new Map<string, any>([['item', item]]);
  retain(map.values(), map);
}
make();
console.log('done');

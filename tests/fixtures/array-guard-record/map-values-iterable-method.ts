function inspect(first: any, second: any): void {
  const next = first.next;
  console.log(first !== second, first.next === second.next);
  console.log(next.call(first).value, next.call(second).value);
  try { next.call({}); } catch (error) { console.log(error instanceof TypeError); }
  console.log(first[Symbol.iterator]() === first, second[Symbol.iterator]() === second);
}
const map = new Map<any, any>([['a', 1], ['b', 2]]);
inspect(map.values(), map.values());

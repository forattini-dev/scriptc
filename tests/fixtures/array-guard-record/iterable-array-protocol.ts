function inspect(array: any): void {
  const iterator = array[Symbol.iterator]();
  const next = iterator.next;
  console.log(iterator[Symbol.iterator]() === iterator, iterator[Symbol.iterator] === array[Symbol.iterator]);
  console.log(Symbol.iterator in iterator, iterator[Symbol.toStringTag], typeof iterator.return);
  console.log(next.call(iterator).value);
  delete array[1];
  const second = next.call(iterator, 42);
  console.log(second.value === undefined, second.done);
  console.log(next.call(iterator).done, next.call(iterator).done);
  try { next.call({}); } catch (error) { console.log(error instanceof TypeError); }
}
inspect(JSON.parse('[1,2]')); 

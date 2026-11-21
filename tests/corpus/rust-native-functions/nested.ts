function outer(seed: number): number {
  let base = seed;
  function add(value: number): number {
    return base + value;
  }
  base = 2;
  return add(3);
}

console.log(outer(1));

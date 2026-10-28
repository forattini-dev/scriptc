// @rust-only
// @no-engine
function make(seed: number): (n: number) => number {
  let count = seed;
  const descend = (n: number): number => {
    count = count + 1;
    return n > 0 ? descend(n - 1) : count;
  };
  return descend;
}
const first = make(10);
const second = make(100);
console.log("closures", first(2), second(1), first(0));
console.log("identity", first === first, first === second);

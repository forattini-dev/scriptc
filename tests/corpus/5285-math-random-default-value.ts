function sample(random: () => number = Math.random): number {
  return random();
}

console.log(sample(() => 0.25));
const value = sample();
console.log(typeof value);
console.log(value >= 0 && value < 1);

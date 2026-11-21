let calls = 0;
function counted(value: number): number { calls++; return value; }
function take(length: number, value: number, ceiling: number): number { return length + value + ceiling; }
function choose(input: number | null | undefined, value: number): number {
  const ceiling = input;
  const derived = ceiling == null ? 0 : counted(value);
  const items = [1, 2];
  return derived === 0 ? 0 : take(items.length, value, ceiling!);
}
console.log('absent', choose(null, 7), choose(undefined, 7), calls);
console.log('zero', choose(5, 0), calls);
console.log('positive', choose(5, 3), calls);
console.log('negative', choose(-4, -3), calls);
console.log('nan', Number.isNaN(choose(1, NaN)), calls);
function reverse(input: number | null): number {
  const ceiling = input;
  const derived = null == ceiling ? 0 : 2;
  const items = [1, 2];
  return 0 !== derived ? take(items.length, 1, ceiling!) : 0;
}
console.log('reverse', reverse(null), reverse(4));
function passthrough(value: number): number { return value; }
function strictNullGuard(input: number | null | undefined, fallback: number): number {
  const value = input;
  const derived = value === null ? 0 : fallback;
  return derived === 0 ? 0 : passthrough(value!);
}
console.log('strict-null', strictNullGuard(undefined, 2), strictNullGuard(null, 2), strictNullGuard(3, 2));

function mix(input: number): number {
  let h = input >>> 0;
  h = h ^ (h << 13);
  h = h ^ (h >>> 17);
  h = h ^ (h << 5);
  h = h + (h << 3);
  h = h ^ (h >>> 11);
  h = h + (h << 15);
  return h >>> 0;
}

function bits(input: number, shift: number): void {
  const a = input | 0;
  const b = shift >>> 0;
  const sum = a + (a << 3);
  const difference = sum - (a >>> 1);
  const and = a & b;
  const or = a | b;
  const xor = a ^ b;
  const left = a << b;
  const signed = a >> b;
  const unsigned = a >>> b;
  const inverted = ~a;
  console.log(sum, difference, and, or, xor, left, signed, unsigned, inverted);
}

const inputs = [0, -0, 1, -1, 0.5, -1.5, 2147483647, -2147483648, 4294967295, 4294967296, 9007199254740991, 9007199254740992, 1e30, NaN, Infinity, -Infinity];
for (const input of inputs) {
  console.log("mix", input, mix(input));
  for (const shift of [0, 1, 31, 32, 33, -1, 63, 1.5, NaN, Infinity]) bits(input, shift);
}

function boundaries(): void {
  const max = 9007199254740991;
  const exact = max - 1;
  const rounded = max + 2;
  const n = -0;
  const neg = n + n;
  const sub = n - 0;
  const zero = (0 | 0) - (0 | 0);
  console.log("bounds", exact, rounded, rounded | 0, 1 / neg, 1 / sub, 1 / zero);
}
boundaries();

function stale(flag: boolean): void {
  let x = 1 | 0;
  if (flag) x = Infinity;
  const afterBranch = x + 2;
  x = 3 | 0;
  const snapshot = x | (x = 4294967297.75);
  const afterWrite = x + 2;
  let count = 0;
  while (count < 3) {
    const previous = x + 1;
    console.log("loop", previous, previous | 0);
    x = count === 0 ? NaN : 2.5;
    count++;
  }
  console.log("stale", afterBranch, snapshot, afterWrite);
}
stale(false);
stale(true);

function captured(): void {
  let x = 1 | 0;
  function replace(): number { x = Infinity; return 1; }
  const snapshot = x | replace();
  const next = x + 1;
  console.log("captured", snapshot, next);
}
captured();

function exceptional(): void {
  let x = 1 | 0;
  try {
    x = Infinity;
    throw new Error("stop");
  } catch {
    console.log("catch", x + 1, x | 0);
  } finally {
    x = -0;
  }
  const sum = x + x;
  console.log("finally", 1 / sum);
}
exceptional();

function ordered(value: number): number { console.log("operand", value); return value; }
console.log("order", (ordered(4294967295) >>> 0) + (ordered(-2147483648) | 0));

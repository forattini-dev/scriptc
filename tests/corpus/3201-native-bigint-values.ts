// @rust-only
// @no-engine
function calculate(value: bigint): bigint {
  const previous = value;
  value = value + 10n;
  return previous * value;
}
function counter(start: bigint): () => bigint {
  let value = start;
  return () => {
    value = value + 1n;
    return value;
  };
}
const next = counter(9007199254740993n);
console.log(String(calculate(3n)), String(next()), String(next()));
const record: { amount: bigint } = { amount: 17n };
record.amount = record.amount * 3n;
console.log(String(record.amount), typeof record.amount, Boolean(record.amount), Boolean(0n));
console.log(BigInt.asIntN(8, 255n).toString(), BigInt.asUintN(8, -1n).toString(16));
console.log(String(~5n), String(5n & 3n), String(5n | 3n), String(5n ^ 3n));
console.log(String(8n << 3n), String(-17n >> 2n), String(8n << -2n));

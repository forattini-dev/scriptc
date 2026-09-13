// @rust-only
// @no-engine
function attempt(run: () => bigint): void {
  try { console.log("value", String(run())); }
  catch (error) {
    if (error instanceof Error) console.log(error.name, error.message);
    else console.log("unexpected error");
  }
}
attempt(() => BigInt("invalid"));
attempt(() => BigInt(1.5));
attempt(() => 1n / 0n);
attempt(() => 1n % 0n);
attempt(() => 2n ** -1n);
attempt(() => BigInt("+"));
attempt(() => BigInt(""));
let visits = 0;
function value(): bigint { visits = visits + 1; return 0n; }
function truth(value: bigint): string { return value ? "nonzero" : "zero"; }
console.log(!value(), visits, truth(0n), truth(1n));
console.log(9007199254740993n > 9007199254740992, 9007199254740992 < 9007199254740993n);
// @ts-expect-error Intentional ECMAScript loose equality across numeric types.
console.log((1n < NaN), (1n >= NaN), 1n == 1, 1n != 1.5);

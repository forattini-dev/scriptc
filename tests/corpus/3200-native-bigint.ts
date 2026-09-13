// @rust-only
// @no-engine
const large = 9007199254740993n;
console.log(String(large), String(large + 2n), String(large * large));
console.log(String(-17n / 5n), String(-17n % 5n));
console.log(String(2n ** 100n));
console.log(String(BigInt("0xffffffffffffffff")));
console.log(String(BigInt(42)), Number(42n));
console.log(large > 9007199254740992n, large === 9007199254740993n);

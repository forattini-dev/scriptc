// @rust-only
// @no-engine
console.log(0 / 0, 1 / 0, -1 / 0, -0, 1 / -0);
console.log(0.0000001, 1e21, 0.1 + 0.2, 0xff, 0b101, 1_000);
console.log(2 ** 8, (-1) ** (1 / 0), (0 / 0) ** 0, (-0) ** -3, 1 ** (0 / 0));
let left: number = 2;
left = left + 0;
console.log(3 % 2, -3 % 2, left === 2, left !== 3);
console.log(1e999, 9007199254740993);

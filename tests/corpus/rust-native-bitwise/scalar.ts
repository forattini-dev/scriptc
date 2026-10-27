// @rust-only
// @no-engine
export {};
console.log(4294967295 | 0, -1 >>> 0, 1 << 31, -8 >> 2);
console.log(7 & 3, 7 ^ 3, ~0, ~4294967295);
console.log(1 << 32, 8 >> -1, -1 >>> 33, -3.9 | 0);
let sixel = 0;
for(let row=0;row<6;row++){sixel |= 1 << row;}
console.log(sixel);

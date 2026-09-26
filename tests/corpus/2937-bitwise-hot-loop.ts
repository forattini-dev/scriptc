// Dependent bitwise chains keep JavaScript's 32-bit coercion and unsigned
// result semantics when every intermediate value feeds the next operation.
let value = 0x12345678;
for (let i = 0; i < 1_000_000; i++) {
  value = (value ^ (value << 13)) >>> 0;
  value = (value ^ (value >>> 17)) >>> 0;
  value = (value ^ (value << 5)) >>> 0;
}
console.log(value);

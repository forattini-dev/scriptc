// @rust-only
// @no-engine
export {};
class Float32Array {
  size: number;
  constructor(size: number) { this.size = size + 10; }
}
class Float64Array {
  size: number;
  constructor(size: number) { this.size = size + 20; }
}
console.log('shadow', new Float32Array(2).size, new Float64Array(3).size);

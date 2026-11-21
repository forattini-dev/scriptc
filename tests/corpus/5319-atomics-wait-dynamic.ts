function pause(ms: number): string {
  return Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

console.log(pause(0));

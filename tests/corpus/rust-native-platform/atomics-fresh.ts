console.log(Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 0));
console.log(Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5));

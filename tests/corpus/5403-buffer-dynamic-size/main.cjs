function allocate(options) {
  if (!Number.isFinite(options.size) || options.size <= 0) throw new Error('bad size');
  return Buffer.allocUnsafe(options.size);
}

const value = allocate({ size: 3 });
console.log(value.length);

function isBytes(value) {
  return value instanceof Uint8Array ||
    typeof Buffer !== "undefined" && value instanceof Buffer;
}

console.log(isBytes(Buffer.from("ok")));
console.log(isBytes(new Uint8Array([1, 2])));
console.log(isBytes("not bytes"));

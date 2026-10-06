function bytes(size: number) {
  const Bytes = class extends Uint8Array { size(): number { return size; } };
  return Bytes;
}
class Sized extends bytes(4) {}
const sized = new Sized(4);
console.log(sized.size());

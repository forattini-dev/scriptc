// @rust-only
// @no-engine

function copy(value) {
  return Buffer.from(value, "utf8");
}

const source = Buffer.from([9, 1, 255, 3, 8]);
const view = source.subarray(1, 4);
const copied = copy(view);
console.log(copied.toString("hex"));
view[0] = 7;
copied[1] = 2;
console.log(view.toString("hex"), copied.toString("hex"));
console.log(copy(new Uint8Array([4, 5])).toString("hex"));

// @rust-only
// @no-engine
function read(bytes: Uint8Array, index: number): number | undefined { return bytes[index]; }
const bytes = new Uint8Array([10, 20, 30]);
console.log("reads", bytes[0] === 10, bytes[2] === 30, bytes[3] === undefined, bytes[-1] === undefined);
function check6(index: number): void {
    const value: number | undefined = read(bytes, index);
    console.log("index", String(index), String(value), value === undefined);
}
check6(-1);
check6(0);
check6(-0);
check6(1);
check6(2);
check6(3);
check6(0.5);
check6((0 / 0));
check6((1 / 0));
check6(-(1 / 0));
check6(4294967296);

const empty = new Uint8Array(0);
console.log("empty", empty[0] === undefined, read(empty, -0) === undefined);
let effects = "";
function receiver(): Uint8Array { effects = effects + "r"; return bytes; }
function index(): number { effects = effects + "i"; return 1; }
console.log("once", receiver()[index()] === 20, effects);
const view = bytes.subarray(1, 2);
console.log("view", view[0] === 20, view[1] === undefined, view[-1] === undefined);

// @rust-only
// @no-engine
function run(): void {
const bytes = new Uint8Array([6]);
let reads = 0;
const index = (n: number): number => { reads = reads + 1; return n; };
const present = bytes[index(0)]!;
const absent = bytes[index(3)]!;
const snapshot = absent;
const capture = (): number | undefined => snapshot;
console.log("index", reads, present, absent);
console.log("bits", present & 7, snapshot & 7, snapshot === undefined);
console.log("closure", capture() === undefined);
console.log("numeric", absent + 1, absent * 2);
bytes[0] = 9;
console.log("captured", present, absent, bytes[0]);
const words = new Int32Array([-1]);
const missingWord = (words[index(4)]! as number);
console.log("wide", words[0], missingWord, missingWord | 1);
}
run();

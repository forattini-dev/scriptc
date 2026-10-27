// @rust-only
// @no-engine
export {};
const values = new Set<string>();
values.add("a"); values.add("b"); values.add("a");
values.delete("a"); values.add("a");
const first: string[] = [...values];
console.log("order", first.join("|"), values.size);
function change(): string { values.add("c"); return "!"; }
const snapshot: string[] = ["<", ...values, change(), ...values, ">"];
console.log("effects", snapshot.join("|"));
const again: string[] = [...values];
first[0] = "changed";
console.log("identity", first === again, again.join("|"));
const numberSet = new Set<number>();
numberSet.add(Number.NaN); numberSet.add(Number.NaN); numberSet.add(-0); numberSet.add(0);
const numbers: number[] = [...numberSet];
console.log("numbers", numbers.length, Number.isNaN(numbers[0]), 1 / numbers[1]);
const seen = new Set([...values, "d"]);
console.log("seed", [...seen].join("|"));

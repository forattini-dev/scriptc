// @rust-only
// @no-engine
// @ts-nocheck
export {};

function test() {
const values: string[] = ["a", "b", "c"];
const alias: any = values;
console.log("deleted", delete alias[1], delete alias[99], values.length);
console.log("keys", Object.keys(alias).join("|"), alias[1] === undefined);
const [head, ...rest] = values;
console.log("rest", head, rest.length, Object.keys(rest).join("|"), rest[0] === undefined, rest[1] === "c");
let visited = "";
values.find((value: string, index: number): boolean => {
  visited = visited + String(index) + (value === undefined ? "u" : "v");
  return false;
});
console.log("find", visited);
try { delete alias.length; } catch (error) { console.log("length", error instanceof TypeError); }
const numbers: number[] = [1, 2];
const numbersAlias: any = numbers;
delete numbersAlias[0];
const [...numberRest] = numbers;
console.log("numbers", numbers.length, numberRest[0] === undefined, numberRest[1] === 2);
const records: { name: string }[] = [{ name: "first" }, { name: "second" }];
const recordsAlias: any = records;
delete recordsAlias[0];
const [...recordRest] = records;
console.log("records", recordRest[0] === undefined, recordRest[1] === recordsAlias[1]);
}
test();

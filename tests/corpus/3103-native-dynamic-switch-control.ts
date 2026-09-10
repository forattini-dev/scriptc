// @no-engine
const first: unknown = JSON.parse('{"id":1}');
const second: unknown = JSON.parse('{"id":1}');
function identity(value: unknown): string {
  switch (value) { case first: return "first"; case second: return "second"; default: return "other"; }
}
console.log(identity(first), identity(second), identity(JSON.parse('{"id":1}')));
let visited = 0;
function failed(): unknown { visited++; throw new Error("case failed"); }
function test(value: unknown): void {
  try {
    switch (value) { case "hit": console.log("hit"); break; case failed(): console.log("wrong"); break; default: console.log("default"); }
  } catch (error) { console.log(String(error)); }
}
test("hit"); test("miss"); console.log(visited);
let effects = 0;
function absent(): undefined { effects++; return undefined; }
function absentCase(value: unknown): void {
  switch (value) { case absent(): console.log("absent"); break; default: console.log("present"); }
}
absentCase(undefined); absentCase(1); console.log(effects);
let total = 0;
outer: for (let i = 0; i < 4; i++) {
  const value: unknown = i;
  switch (value) {
    case 0: continue outer;
    case 1: total += 1; break;
    case 2: total += 2;
    default: total += 10;
  }
}
console.log(total);

const callback: unknown = () => 1;
const otherCallback: unknown = () => 1;
function functionIdentity(value: unknown): string {
  switch (value) { case callback: return "callback"; default: return "other"; }
}
console.log(functionIdentity(callback), functionIdentity(otherCallback));

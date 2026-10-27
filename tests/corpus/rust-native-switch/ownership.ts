// @rust-only
// @no-engine
export {};
const first = {value: 1};
const second = {value: 1};
function identity(value: any): string {
  switch (value) { case first: return "first"; case second: return "second"; default: return "other"; }
}
console.log("identity", identity(first), identity(second), identity({value: 1}));
const saved = {first: () => 0, second: () => 0};
for (const value of [1, 2]) {
  switch (value) {
    case 1: { let local = 10; saved.first = () => local; local++; break; }
    default: { let local = 20; saved.second = () => local; local++; break; }
  }
}
console.log("capture", saved.first(), saved.second());
function hoisted(value: number): string {
  switch (value) {
    case 1: var result = "one"; break;
    default: result = "other";
  }
  return String(result);
}
console.log("var", hoisted(1), hoisted(4));

// @rust-only
// @no-engine
// Spreads retain source order and aliases, evaluate once, and never move an
// overwritten key; canonical array-index keys enumerate before string keys.
interface State { alpha: number; beta: number; child: { count: number } }
function build(reverse: boolean): State {
  if (reverse) return { beta: 2, alpha: 1, child: { count: 3 } };
  return { alpha: 1, beta: 2, child: { count: 3 } };
}
const original = build(true);
let events = "";
function source(): State { events += "source;"; return original; }
function appended(): number { events += "value;"; return 7; }
const copy = { ...source(), gamma: appended() };
console.log(events, Object.keys(copy).join(","), JSON.stringify(copy));
copy.child.count = 9;
console.log(original.child.count);
const update = { ...original, alpha: 8 };
console.log(Object.keys(update).join(","), JSON.stringify(update));
const indexed: { a: number; "10": number; "2": number } = { "10": 10, a: 1, "2": 2 };
console.log(Object.keys(indexed).join(","), JSON.stringify(indexed));

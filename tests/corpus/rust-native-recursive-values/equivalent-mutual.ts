// @rust-only
// @no-engine
interface LeftA { next?: RightA; name: string; }
interface RightA { back: LeftA; count: number; }
interface LeftB { name: string; next?: RightB; }
interface RightB { count: number; back: LeftB; }

function project(value: LeftA): LeftA { return value; }
const left: LeftB = { name: "left" };
const right: RightB = { count: 3, back: left };
left.next = right;
const alias = project(left);
console.log(alias === left);
if (alias.next !== undefined) {
  console.log(alias.next === right, alias.next.back === alias);
  alias.next.count = 17;
  alias.next.back.name = "changed";
}
console.log(right.count, left.name);
const newLeft: LeftA = { name: "new" };
if (alias.next !== undefined) alias.next.back = newLeft;
console.log(right.back === newLeft, right.back.name);

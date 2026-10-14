// @no-engine
type Left = { kind: "left"; value: number };
type Right = { kind: "right"; value: number; extra?: number };
type Choice = Left | Right;

function makeLeft(): { kind: "left"; value: number; spare: number } {
  return { kind: "left", value: 3, spare: 9 };
}
function makeRight(): { kind: "right"; value: number; extra: number; spare: number } {
  return { kind: "right", value: 7, extra: 11, spare: 9 };
}
function describe(choice: Choice): string {
  return choice.kind === "left" ? `left:${choice.value}` : `right:${choice.value}:${choice.extra}`;
}
function returnedChoice(): Choice { return makeRight(); }
const left: Choice = makeLeft();
const right: Choice = makeRight();
console.log(describe(left), describe(right));
console.log(describe(makeLeft()), describe(makeRight()));
console.log(describe(returnedChoice()));
function leftArray(): { kind: "left"; value: number; spare: number }[] { return [makeLeft()]; }
function rightArray(): { kind: "right"; value: number; extra: number; spare: number }[] { return [makeRight()]; }
const leftItems: Left[] | Right[] = leftArray();
const rightItems: Left[] | Right[] = rightArray();
console.log(leftItems[0]!.kind, rightItems[0]!.kind, leftItems.length, rightItems.length);

class Box {
  value: string | undefined = "ready";
  clear(): void { this.value = undefined; }
}
function acceptsOptional(value: string | undefined): string {
  return value === undefined ? "missing" : value;
}
function widenedAfterCall(box: Box): string {
  if (box.value !== undefined) {
    box.clear();
    return acceptsOptional(box.value);
  }
  return "empty";
}
function guardedAfterCall(box: Box): string {
  if (box.value !== undefined) {
    box.clear();
    return box.value.length.toString();
  }
  return "empty";
}
console.log(widenedAfterCall(new Box()));
try { console.log(guardedAfterCall(new Box())); }
catch (error) { console.log(error instanceof TypeError); }

class LiteralBox {
  value: "left" | "right" | undefined = "left";
  change(): void { this.value = "right"; }
}
function wideLiteral(box: LiteralBox): string | undefined {
  if (box.value === "left") { box.change(); return box.value; }
  return undefined;
}
function exactLiteral(box: LiteralBox): "left" | undefined {
  if (box.value === "left") { box.change(); return box.value; }
  return undefined;
}
console.log(wideLiteral(new LiteralBox()), exactLiteral(new LiteralBox()));

type Item = { pos: number; end: number };
const items: Item[] = [{ pos: 2, end: 4 }, { pos: 5, end: 8 }];
const callback: (item: { pos: number }) => number = (item) => item.pos + 1;
console.log(items.map(callback).join(","), items[0]!.end);

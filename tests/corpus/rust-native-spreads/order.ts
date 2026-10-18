let trace = "";
let reads = 0;
function text(mark: string): string { trace = trace + mark; return mark; }
function condition(mark: string, yes: boolean): boolean { trace = trace + mark; reads = reads + 1; return yes; }
function build(yes: boolean): { first: string; x?: string; y?: string; last?: string } {
  return {
    first: text("A"),
    ...(condition("B", yes) ? { x: text("C"), ...(condition("D", true) ? { y: text("E") } : { y: text("!") }) } : {}),
    last: text("F"),
    ...(condition("G", yes) ? { x: text("H") } : { x: text("I") }),
  };
}
const a = build(true);
console.log("order", trace, reads, a.first, a.x === "H", a.y === "E", a.last === "F");
const ka = Object.keys(a);
console.log(ka.length, ka[0], ka[1], ka[2], ka[3]);
trace = "";
const b = build(false);
console.log("order", trace, reads, b.x === "I", Object.hasOwn(b, "y"));
const kb = Object.keys(b);
console.log(kb.length, kb[0], kb[1], kb[2]);
function captured() {
  let state = "before";
  const write = () => { state = "after"; return true; };
  const value: { first: string; last?: string } = { first: state, ...(write() ? { last: state } : {}) };
  return value;
}
const c = captured();
console.log("capture", c.first, c.last === "after");

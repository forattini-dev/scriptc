let trace = 0;
function mark(n: number): number { trace = trace * 10 + n; return n; }
function color(x: number, y: number): { r: number; g: number; b: number } {
  if (x < 0) return { r: -0, g: Infinity, b: NaN };
  search: for (let i = 0; i < 3; i++) {
    if (i > x) break search;
    if (i === x) return { b: mark(3), r: mark(1) + x, g: mark(2) + y };
    continue search;
  }
  return { r: x, g: y, b: x + y };
}
function render(): void {
  const first = color(mark(1), mark(2));
  console.log("order", trace, first.r, first.g, first.b);
  const special = color(-1, 0);
  console.log("ieee", 1 / special.r, special.g, special.b);
  let total = 0;
  outer: for (let i = 0; i < 5; i++) {
    const c = color(i, 10);
    if (i === 1) continue outer;
    total += c.r + c.g + c.b;
    if (i === 3) break outer;
  }
  console.log("loops", total);
}
render();
function fail(): number { throw new Error("field"); }
function throwing(): { x: number; y: number } { return { x: mark(4), y: fail() }; }
try {
  const c = throwing();
  console.log(c.x, c.y);
} catch (e) { console.log("throw", (e as Error).message, trace); }
finally { console.log("finally"); }
function immutable(x: number): { value: number } { return { value: x }; }
function fallback(): void {
  const original = immutable(5);
  const alias = original;
  alias.value = 8;
  console.log("alias", original === alias, original.value);
  const observed = immutable(6);
  console.log("identity", observed === observed);
  const captured = immutable(7);
  function read(): number { return captured.value; }
  console.log("captured", read());
}
fallback();
function withFinally(): { x: number } {
  try { return { x: 10 }; } finally { console.log("producer-finally"); }
}
function finalResult(): void { const c = withFinally(); console.log("fallback-finally", c.x); }
finalResult();
function unused(): { used: number; ignored: number } { return { ignored: mark(6), used: 11 }; }
function onlyOneField(): void {
  const c = unused();
  console.log("unused-effect", c.used, trace);
}
onlyOneField();
function withHeader(): void {
  for (const c = immutable(12); c.value > 0;) {
    console.log("header", c.value);
    break;
  }
}
withHeader();
const numbers = [2, 4, 6];
function fromIterable(stop: boolean): { value: number } {
  for (const n of numbers) {
    switch (n) {
      case 2: if (stop) return { value: n }; break;
      case 4: continue;
      default: return { value: n };
    }
  }
  return { value: -1 };
}
function iterableResults(): void {
  for (let i = 0; i < 3; i++) {
    try {
      const c = fromIterable(i === 0);
      console.log("iterable", c.value);
    } finally { console.log("iteration-finally", i); }
  }
}
iterableResults();

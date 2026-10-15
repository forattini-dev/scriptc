// @rust-only
// @no-engine
async function main(): Promise<void> {
  const ns = await import("./module.ts");
  const held = ns.state;
  const inner = held.nested;
  console.log("reads", ns.state.label, ns.state.nested.count, inner === ns.state.nested);
  ns.reset();
  ns.get().nested.count = ns.rhs();
  console.log("write order", ns.order, inner.count, held === ns.state);
  ns.reset();
  const value = ns.get().nested.count;
  console.log("read once", ns.order, value);
  ns.reset();
  try { ns.get().nested.count = ns.throwingRhs(); } catch (error) { console.log("throw", (error as Error).message); }
  console.log("throw order", ns.order, inner.count);
  ns.state.nested = { count: 9 };
  console.log("replacement", held.nested === ns.state.nested, inner !== held.nested, inner.count, held.nested.count);
  const number = ns.numbers.absent;
  const text = ns.texts.absent;
  const flag = ns.flags.absent;
  console.log("missing number", ns.numbers.absent, typeof ns.numbers.absent, number, number === undefined, number ?? 9);
  console.log("missing text", text, typeof text, text === undefined, text ?? "fallback");
  console.log("missing flag", flag, typeof flag, flag === undefined, flag ?? true);
  console.log("present", ns.numbers.present, ns.texts.present, ns.flags.present);
  console.log("string consumers", ns.texts.present.length, ns.texts.present.trim(), ns.texts.absent?.trim());
  try { console.log(ns.texts.absent.length); } catch (error) { console.log("missing length", (error as Error).message); }
  try { console.log(ns.texts.absent.trim()); } catch (error) { console.log("missing method", (error as Error).message); }
  let keyCalls = 0;
  function index(): number { keyCalls++; return 0; }
  console.log("string index", ns.texts.present[index()], keyCalls);
  try { console.log(ns.texts.absent[index()]); } catch (error) { console.log("missing index", (error as Error).message, keyCalls); }
  const dictionary = ns.numbers;
  const aliased = dictionary.absent;
  console.log("aliased missing", aliased, aliased === undefined);
  ns.numbers.absent = 7;
  console.log("new field", ns.numbers.absent, number === undefined);
}
await main();
export {};

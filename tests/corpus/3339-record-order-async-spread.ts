// @rust-only
// @no-engine
// A spread snapshots scalar fields before suspension, but keeps nested aliases.
interface State { alpha: number; beta: number; child: { count: number } }
function initial(reverse: boolean): State {
  if (reverse) return { beta: 2, alpha: 1, child: { count: 3 } };
  return { alpha: 1, beta: 2, child: { count: 3 } };
}
const base = initial(true);
const trace: string[] = [];
function source(label: string): State {
  trace.push(label);
  return base;
}
async function update(): Promise<number> {
  trace.push("await:start");
  await Promise.resolve();
  base.beta = 20;
  base.child.count = 30;
  trace.push("await:end");
  return 7;
}
function after(): number { trace.push("after"); return 8; }
async function build(): Promise<State> {
  const plain = { ...source("plain"), alpha: await update(), gamma: after() };
  console.log(Object.keys(plain).join(","), JSON.stringify(plain));
  try {
    return { ...source("protected"), alpha: await update() };
  } finally { trace.push("finally"); }
}
const result = await build();
result.child.count = 99;
console.log(Object.keys(result).join(","), JSON.stringify(result), base.child.count);
console.log(trace.join(","));
export {};

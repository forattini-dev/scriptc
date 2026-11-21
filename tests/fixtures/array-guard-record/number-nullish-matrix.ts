type Context = { freq?: number; words: number };
let calls = 0;
const custom: any = { label: 'C', toFixed(digits: number) { calls++; return this.label + digits; } };
const inputs = ['{}', '{"freq":null}', '{"freq":0}', '{"freq":0.125}', '{"freq":-1.25}', '{"freq":"0.1"}', '{"freq":false}', '{"freq":{}}'];
function observe(ctx: Context, mode: number) {
  if (mode === 0) return (ctx.freq ?? 0).toFixed(2);
  if (mode === 1) return `v:${(ctx.freq ?? 0).toFixed(2)}`;
  if (mode === 2) return { found: `${(ctx.freq ?? 0).toFixed(2)}` };
  return ctx.words > 300 && (ctx.freq ?? 0) < 0.5 ? { found: `${(ctx.freq ?? 0).toFixed(2)}` } : null;
}
for (let i = 0; i < inputs.length; i++) {
  const ctx = JSON.parse(inputs[i]) as Context;
  ctx.words = 400;
  if (i === 7) (ctx as any).freq = custom;
  for (let mode = 0; mode < 4; mode++) {
    try { console.log(i, mode, JSON.stringify(observe(ctx, mode)), calls); }
    catch (error) { console.log(i, mode, 'caught', error instanceof TypeError, calls); }
  }
}

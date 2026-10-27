// @ts-nocheck
// @rust-only
// @no-engine
export {};

const values = new Float32Array([Number('bad'), 7]);
for (const key of [-1, 0.5, 2, 1 / 0, Number('bad')]) {
  console.log('missing', String(values[key]));
  console.log('ignored', values[key] = 9, String(values[key]));
  console.log('compound', values[key] += 2, String(values[key]));
}
values[-0] = 3;
console.log('zero', values[0], values[1], values.length);
try { values[10] = 1n; } catch (error) { console.log('bigint', String(error.name), String(error.message)); }
try { values[10] = Symbol('x'); } catch (error) { console.log('symbol', String(error.name), String(error.message)); }
console.log('after', values.join(','));

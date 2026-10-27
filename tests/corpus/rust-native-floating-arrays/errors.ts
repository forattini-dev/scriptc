// @ts-nocheck
// @rust-only
// @no-engine
export {};
try { new Float32Array(-1); } catch (error) { console.log('length', String(error.name), String(error.message)); }
const owner = new Float64Array([1, 2]);
try { owner.set(new Float64Array([3, 4]), 1); } catch (error) { console.log('overflow', String(error.name), String(error.message)); }
console.log('unchanged', owner.join(','));
try { owner.set(new Float64Array([3]), -1); } catch (error) { console.log('offset', String(error.name), String(error.message)); }
owner[0] = -0;
console.log('zero', 1 / owner[0], new Float32Array(Number('bad')).length);

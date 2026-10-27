// @ts-nocheck
// @rust-only
// @no-engine
export {};

let trace = '';
let current = new Float32Array([2]);
const original = current;
function receiver(): Float32Array { trace += 'R'; return current; }
function key(): number { trace += 'K'; return 0; }
function right(): number {
  trace += 'V';
  original[0] = 100;
  current = new Float32Array([9]);
  return 3;
}
console.log('result', receiver()[key()] += right());
console.log('owner', trace, original[0], current[0]);
function failed(): number { trace += 'X'; throw new Error('stop'); }
try { receiver()[key()] = failed(); } catch (error) { console.log('throw', trace, String(error.message), current[0]); }
try { receiver()[key()] += 1n; } catch (error) { console.log('mixed', trace, String(error.name), current[0]); }

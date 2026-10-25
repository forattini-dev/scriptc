// @rust-only
// @no-engine
let trace = ''; let i = 0;
while (i < 3) {
  i = i + 1;
  try { trace = trace + 'T'; if (i === 1) continue; break; }
  finally { trace = trace + 'F'; }
}
console.log('cleanup', i, trace);
function replacement(): number { while (true) { try { return 1; } finally { break; } } return 9; }
console.log('replace return', replacement());
function repeatedReturn(): number {
  let n = 0;
  while (n < 2) { n = n + 1; try { return n; } finally { if (n === 1) continue; } }
  return 0;
}
console.log('replace with continue', repeatedReturn());
trace = ''; i = 0;
while (i < 2) {
  i = i + 1;
  try {
    try { continue; } finally { trace = trace + 'a'; }
  } finally {
    let j = 0;
    while (j < 2) { j = j + 1; if (j === 1) continue; break; }
    trace = trace + 'b';
  }
}
console.log('nested finalizers', trace);
trace = ''; i = 0;
while (i < 2) {
  i = i + 1;
  try { throw new Error('caught'); }
  catch (e) { trace = trace + (e as Error).message; continue; }
  finally { trace = trace + '!'; }
}
console.log('catch continue', trace);
try { while (true) { try { break; } finally { throw new Error('override'); } } }
catch (e) { console.log('throw override', (e as Error).message); }
try { let n = 0; while (n < 2) { n = n + 1; if (n === 1) continue; break; } console.log('local target', n); }
finally { console.log('outer cleanup'); }
export {};

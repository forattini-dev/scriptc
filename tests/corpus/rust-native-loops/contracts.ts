// @rust-only
// @no-engine
let i = 0;
let trace = '';
while (i < 5) {
  i = i + 1;
  if (i === 2) continue;
  if (i === 4) break;
  trace = trace + String(i);
}
console.log('basic', i, trace);
let checks = 0;
function condition(): boolean { checks = checks + 1; return checks < 4; }
while (condition()) { if (checks === 2) continue; }
console.log('condition', checks);
let outer = 0; let count = 0;
while (outer < 3) {
  outer = outer + 1;
  let inner = 0;
  while (inner < 4) {
    inner = inner + 1;
    if (inner === 2) continue;
    if (inner === 3) break;
    count = count + 1;
  }
}
console.log('nested', outer, count);
let remaining: number | undefined = 2;
while (remaining !== undefined) { console.log('guard', remaining); remaining = undefined; }
console.log('exit', remaining === undefined);
let dynamic: unknown = 'yes';
while (dynamic) { console.log('truthy'); dynamic = 0; }
while (false) { console.log('never'); }
function forever(): number { while (true) { return 7; } }
console.log('return', forever());
export {};

// @rust-only
// @no-engine
let i = 0;
type Entry = { get: () => number };
const callbacks: Entry[] = [];
while (i < 3) {
  let value = i;
  callbacks.push({ get: (): number => value });
  value = value + 10;
  i = i + 1;
}
console.log('fresh cells', callbacks[0].get(), callbacks[1].get(), callbacks[2].get());
let shared = 0;
const outer: Entry[] = [];
while (shared < 3) { outer.push({ get: (): number => shared }); shared = shared + 1; }
console.log('shared cell', outer[0].get(), outer[1].get(), outer[2].get());
function localLoop(): number {
  let value = 0;
  const run = (): number => { let n = 0; while (n < 3) { n = n + 1; if (n === 2) break; } return n; };
  while (value < 1) { value = run(); }
  return value;
}
console.log('function boundary', localLoop());
export {};

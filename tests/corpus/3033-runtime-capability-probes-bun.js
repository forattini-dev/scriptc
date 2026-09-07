// @target bun
// SDK-style runtime detection must short-circuit absent runtime globals.
const isBun = typeof globalThis.Bun !== 'undefined' && typeof globalThis.Bun.spawn === 'function';
const isDeno = typeof globalThis.Deno !== 'undefined' && typeof globalThis.Deno.Command === 'function';
console.log(typeof globalThis.Bun, typeof globalThis.Deno, isBun, isDeno);
let calls = 0;
function touch() { calls++; return true; }
console.log(typeof globalThis.Bun !== 'undefined' && touch());
console.log(typeof globalThis.Deno === 'undefined' || touch());
console.log(calls);
function shadow(globalThis) {
  return typeof globalThis.Bun;
}
console.log(shadow({ Bun: 42 }));

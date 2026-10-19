// @rust-only
// @no-engine
import "./tdz-b.ts";
export let pending: number = 42;
console.log("initialized", pending);
export function writeEarly(): void { pending = rhs(); }
function rhs(): number { console.log("rhs before write"); return 99; }

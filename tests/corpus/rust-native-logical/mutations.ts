// @rust-only
// @no-engine
let slot: any = {value: 1};
const original = slot;
let visits = 0;
function get(): any { visits = visits + 1; return slot; }
function replace(): any { slot = {value: 2}; return slot; }
console.log("left", (get() || replace()) === original, visits, slot === original);
console.log("right", (get() && replace()) === slot, visits, slot === original);
let nullable: any = null;
function fill(): any { nullable = {value: 4}; return nullable; }
console.log("null", (nullable || fill()) === nullable, `${nullable.value}`);

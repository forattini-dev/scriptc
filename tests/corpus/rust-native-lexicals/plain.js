// @rust-only
// @no-engine
let memo;
console.log("bare", typeof memo);
memo = "ready";
console.log("assigned", memo);
function local() {
  let value;
  console.log("local", typeof value);
  value = 4;
  console.log("local assigned", value);
}
local();

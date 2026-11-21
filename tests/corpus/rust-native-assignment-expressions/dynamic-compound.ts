// @rust-only
// @no-engine
function add(value: any): void {
  let total = 1;
  total += value;
  console.log(`dynamic ${total}:${typeof total}`);
}

add(2);
add("x");

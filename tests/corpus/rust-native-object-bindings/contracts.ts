// @rust-only
// @no-engine
export {};
function read(): void {
  const data = {count: 3, text: "ok", "0": 8, "space key": true};
  const {count, text: alias, 0: zero, "space key": spaced} = data;
  console.log(count, alias, zero, spaced);
  let {count: mutable} = data;
  mutable = 9;
  console.log(mutable, data.count);
  const {} = data;
  for (let {count: i} = data; i > 0; i--) {
    if (i === 2) continue;
    console.log("loop", i);
  }
}
read();

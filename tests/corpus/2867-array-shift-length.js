// A shift guarded by the source array's length produces a runtime-optional
// string. Its property read extracts the present value and preserves Node's
// TypeError path if the algorithmic guard ever fails.
const values = ["alpha", "beta"];
while (values.length) {
  const value = values.shift();
  console.log(value.length, value[0], /^a/.test(value), value.indexOf("a"), value.slice(1));
}

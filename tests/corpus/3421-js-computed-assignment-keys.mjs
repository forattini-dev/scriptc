const first = Symbol("key");
const second = Symbol("key");
function write(target, key, value) { return (target[key] = value); }
function check(target) {
  const child = (target[first] = { value: 1 });
  child.value = 7;
  console.log(child === target[first], target[first].value, target[second]);
  console.log(write(target, second, 2), target[first].value, target[second]);
  console.log(write(target, -0, "zero"), write(target, true, "boolean"));
  console.log(write(target, null, "null"), write(target, undefined, "undefined"));
  console.log(target[0], target["true"], target["null"], target["undefined"]);
  console.log(write(target, 5n, "bigint"), target["5"]);
}
check({});

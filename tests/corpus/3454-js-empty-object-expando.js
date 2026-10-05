// @rust-only
// @no-engine
function exercise(write) {
  const object = {};
  const alias = object;
  console.log(Object.keys(object).length, Object.hasOwn(object, "value"));
  if (write) object.value = 4;
  console.log(alias.value === undefined, Object.hasOwn(alias, "value"));
  alias.value = "changed";
  console.log(object.value, object === alias, JSON.stringify(object));
}
exercise(true);
exercise(false);
const shared = {};
console.log(Object.keys(shared).length);
shared.family = 4;
console.log(shared.family, Object.keys(shared).join(","));
console.error("open objects finished");

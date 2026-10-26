// @ts-nocheck
// @rust-only
// @no-engine
var groups = {};
let other = {};
const third = {};
const alias = groups;
function install() {
  groups.global = {size: 1};
  other.name = "other";
  third.enabled = true;
}
install();
console.log("module", groups === alias, alias.global.size === 1, other.name === "other", third.enabled === true);
groups.global.size = 7;
console.log("shared", alias.global.size === 7);
function local() {
  var value = {};
  const alias = value;
  const set = () => { value.name = "local"; };
  set();
  value["2"] = 2;
  return alias;
}
const value = local();
console.log("local", value.name === "local", value["2"] === 2);
groups.global = "changed";
console.log("retag", alias.global === "changed");
delete groups.global;
console.log("delete", alias.global === undefined);

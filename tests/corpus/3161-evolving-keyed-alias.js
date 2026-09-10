// @dynamic
// Evolving globals and locals retain their original object across keyed
// operations, aliases and changes between object and array values.
let bag;
bag = {};
const alias = bag;
let order = "";
function key() { order += "k"; return 9; }
function value() { order += "v"; return 23; }
bag[key()] = value();
bag["name"] = "first";
alias["name"] = "changed";
console.log(`${alias[9]}:${order}:${bag["name"]}:${bag["missing"]}`);
bag = [];
bag[2] = "tail";
console.log(`${bag["length"]}:${JSON.stringify(bag)}:${bag[2]}:${alias[9]}`);

function localProbe() {
  let local;
  local = {};
  const shared = local;
  local["x"] = 1;
  shared["x"] = 2;
  local[-1] = "negative";
  return `${local["x"]}:${shared[-1]}:${local["absent"]}`;
}
console.log(localProbe());

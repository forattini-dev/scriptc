console.log("local:init");

function add(a, b) {
  return a + b;
}

module.exports = { add, label: "local-cjs" };

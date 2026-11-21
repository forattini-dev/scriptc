// Mirrors yaml's visitor: each step freezes a fresh path array built with
// concat, and the traversal only reads it.
function visit(node, path, out) {
  out.push(`${path.length}:${path.join(">")}:${node.name}`);
  const next = Object.freeze(path.concat(node.name));
  for (const child of node.children) {
    visit(child, next, out);
  }
}

const tree = {
  name: "root",
  children: [
    { name: "a", children: [{ name: "a1", children: [] }] },
    { name: "b", children: [] },
  ],
};
const lines = [];
visit(tree, Object.freeze([]), lines);
console.log(lines.join("\n"));

const original = ["x", "y"];
const frozen = Object.freeze(original);
console.log(frozen === original, frozen.length, frozen[1], frozen.indexOf("y"));
console.log([...frozen, "z"].join(","), frozen.slice(1).join(","));

function mutate(label, action) {
  try {
    action();
    console.log(label, "allowed");
  } catch (error) {
    console.log(label, error instanceof TypeError);
  }
}

mutate("push", () => frozen.push("z"));
mutate("pop", () => frozen.pop());
mutate("index", () => {
  frozen[0] = "w";
});
console.log(frozen.join(","), frozen.length);

const copy = frozen.concat("z");
copy.push("again");
console.log(copy.join(","));

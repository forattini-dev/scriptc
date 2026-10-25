// @rust-only
// @no-engine
const factory = () => ({ type: "box", props: {}, children: [], key: undefined });
const node = factory();
const alias = node;
alias.children.push({ id: "child", key: undefined });
alias.key = "assigned";
console.log("mutated", node.key === "assigned", node.children.length, node.children[0].id === "child", alias === node);
alias.key = undefined;
console.log("reset", node.key === undefined, node.children[0].key === undefined);
const child = node.children[0];
child.id = "changed";
console.log("element identity", alias.children[0].id === "changed");

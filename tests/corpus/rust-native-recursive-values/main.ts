interface Tree {
  name: string;
  children: Tree[];
}

function names(tree: Tree): string {
  return tree.name + tree.children.map(child => names(child)).join(":");
}

const leaf: Tree = { name: "leaf", children: [] };
const root: Tree = { name: "root", children: [leaf, leaf] };
console.log(names(root));
leaf.name = "changed";
console.log(names(root));
console.log(root.children[0] === root.children[1]);

// Creating a cycle must preserve handles; the native heap audit must reclaim it.
leaf.children.push(root);
console.log(leaf.children[0] === root);

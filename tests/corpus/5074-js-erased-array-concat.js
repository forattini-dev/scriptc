// @ts-nocheck
function walk(path, node, visitor) {
  visitor(node, path);
  if (node === 0) return path;
  return walk(Object.freeze(path.concat([["value", node]])), node - 1, visitor);
}

const result = walk(Object.freeze([]), 2, () => {});
console.log(result.length);

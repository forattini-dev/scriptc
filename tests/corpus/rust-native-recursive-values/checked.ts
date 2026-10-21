interface Node {
  loop?: Node;
  zLabel: { text: string };
}
const node: Node = { zLabel: { text: "ok" } };
node.loop = node;
const erased: any = node;
const checked = erased as Node;
const saved = node.zLabel;
console.log(checked === node);
if (checked.loop !== undefined) console.log(checked.loop === node);

// A back edge must not hide a bad sibling, or cache validation across writes.
erased.zLabel = null;
try {
  const bad = erased as Node;
  console.log(bad.zLabel.text);
} catch (error) {
  console.log(error instanceof TypeError);
}
erased.zLabel = saved;
const restored = erased as Node;
console.log(restored.zLabel.text);

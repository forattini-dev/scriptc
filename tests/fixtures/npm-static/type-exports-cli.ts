import { run, type Shape, type TaggedShape, type Branch, type Option, type Token } from "type-exports";

const shape: Shape = { value: run(), label: "native" };
console.log(shape.label, shape.value);
const copied: Readonly<Shape> = { value: shape.value + 1, label: "mapped" };
const tagged: TaggedShape = { value: run(), label: "intersection", tag: "plain" };
const branch: Branch = { value: run(), children: [{ value: 8, children: [] }] };
console.log(copied.label, copied.value, tagged.tag, branch.children[0]!.value);
const option: Option = { name: "help" };
const token: Token = { value: run() };
console.log(option.name, token.value);
console.error("type exports preserved");

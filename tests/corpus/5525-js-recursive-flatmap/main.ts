import { normalizeChildren, type VNode } from "./nodes.mjs";

const node: VNode = { type: "existing", props: {}, children: [] };
const result = normalizeChildren(["alpha", null, false, 42, node]);
console.log("length", result.length);
console.log("text", result[0].props.children, result[1].props.children);
console.log("identity", result[2] === node);
console.log("absent", normalizeChildren(undefined).length);

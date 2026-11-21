// @rust-only
// @no-engine
interface VNode {
  type: string;
  props: Record<string, unknown>;
  children: VNode[];
  key?: string | number;
}
type Child = VNode | string | number | boolean | null | undefined;

const leaf: VNode = { type: "text", props: {}, children: [] };
const raw: { type: string; props: any; children: any } = {
  type: "box",
  props: { color: "blue" },
  children: [leaf],
};

function accept(...values: Child[]): void {
  const value = values[0];
  if (typeof value === "object" && value !== null) {
    value.props.checked = true;
    value.children[0].type = "changed";
  }
}

accept(raw);
console.log("recursive identity", raw.children[0] === leaf, leaf.type);

type RenderInput = (() => VNode) | VNode;
function render(...inputs: RenderInput[]): void {
  console.log("render inputs", inputs.length);
}
function App() {
  return raw;
}
render(App);
console.log("callable union", raw.type);

function maybeNode(enabled: boolean): VNode | null {
  return enabled ? leaf : null;
}
function requireNode(node: VNode): void {
  node.type = "required";
}
requireNode(maybeNode(true)!);
console.log("nonnull view", leaf.type);

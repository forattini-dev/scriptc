// @rust-only
// @no-engine

interface PublicNode {
  type: string;
  props: unknown;
  children: unknown;
}

interface ConcreteNode {
  type: string;
  props: { label: string };
  children: string[];
  key?: string;
}

function concrete(): ConcreteNode {
  return {
    type: "box",
    props: { label: "ready" },
    children: ["child"],
  };
}

function published(): PublicNode {
  return concrete();
}

const node = published();
console.log(node.type);

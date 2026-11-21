class BaseNode {
  readonly kind: string;
  constructor(kind: string) {
    this.kind = kind;
  }
}

class ElementNode extends BaseNode {
  readonly name: string;
  constructor(name: string) {
    super("element");
    this.name = name;
  }
}

type Predicate = (node: BaseNode) => node is ElementNode;

function existsOne(test: Predicate, nodes: BaseNode[]): boolean {
  return nodes.some((node) => test(node));
}

function findOne(test: Predicate, nodes: BaseNode[]): ElementNode | null {
  for (const node of nodes) {
    if (test(node)) return node;
  }
  return null;
}

const isElement = (node: BaseNode): node is ElementNode => node.kind === "element";
const nodes: BaseNode[] = [new BaseNode("text"), new ElementNode("main")];
console.log(existsOne(isElement, nodes), findOne(isElement, nodes)?.name);

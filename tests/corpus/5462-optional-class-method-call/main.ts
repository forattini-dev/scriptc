class SearchNode {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  search(key: string): SearchNode | null {
    return key === this.value ? this : null;
  }
}

class Tree {
  node: SearchNode | null = null;

  lookup(key: string): string | null {
    return this.node?.search(key)?.value ?? null;
  }
}

const tree = new Tree();
console.log(tree.lookup("x"));
tree.node = new SearchNode("x");
console.log(tree.lookup("x"), tree.lookup("y"));

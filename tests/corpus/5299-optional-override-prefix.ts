class NodeBase {
  clone(): string {
    return 'base';
  }
}

class Collection extends NodeBase {
  clone(schema?: string): string {
    return schema ?? 'collection';
  }
}

function cloneBase(node: NodeBase): string {
  return node.clone();
}

console.log(cloneBase(new Collection()));
console.log(new Collection().clone('schema'));

class Pair {
  value: string;

  constructor(value: string) {
    this.value = value;
  }
}

class MapBase {
  add(pair: Pair, overwrite: boolean): string {
    return overwrite ? pair.value : 'base';
  }
}

class SetChild extends MapBase {
  add(pair: any): string {
    return pair.value;
  }
}

function addThroughBase(map: MapBase, pair: Pair): string {
  return map.add(pair, true);
}

console.log(addThroughBase(new SetChild(), new Pair('set-child')));

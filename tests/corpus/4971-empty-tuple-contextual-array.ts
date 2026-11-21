interface Item {
  values: readonly string[];
}

const source = { values: [] } as const satisfies Item;
const items: readonly Item[] = [source];
console.log(items[0]!.values.length);

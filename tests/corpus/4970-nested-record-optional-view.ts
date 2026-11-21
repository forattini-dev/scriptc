interface Layers {
  key: string;
  aliases?: readonly string[];
}
interface Binding {
  id: string;
  layers: Layers;
}

const source = {
  id: "newline",
  layers: { key: "enter", aliases: ["return"] },
} as const satisfies Binding;
const bindings: readonly Binding[] = [source];
console.log(`${bindings[0]!.layers.key}:${bindings[0]!.layers.aliases![0]}`);

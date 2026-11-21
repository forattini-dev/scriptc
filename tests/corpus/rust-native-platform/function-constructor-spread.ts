const effects: string[] = [];

function argumentList(): string[] {
  effects.push("spread");
  return ["return 1"];
}

try {
  const DynamicFunction = Function;
  new DynamicFunction(...argumentList());
  effects.push("selected");
} catch {
  effects.push("selected");
}

console.log(effects.join(","));

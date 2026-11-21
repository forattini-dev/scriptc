/// <reference path="./5166-types/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />

const source = `title = "native"
enabled = true
count = 3
items = ["a", "b"]

[tools]
node = "latest"
bun = { version = "1.2.3", enabled = false }

[[targets]]
name = "first"

[[targets]]
name = "second"
`;

type Parsed = {
  title: string;
  enabled: boolean;
  count: number;
  items: string[];
  tools: Record<string, string | { version: string; enabled: boolean }>;
  targets: Array<{ name: string }>;
};

const parsed = (process.env.SCRIPTC_NATIVE_TOML === "1"
  ? Bun.TOML.parse(source)
  : {
      title: "native",
      enabled: true,
      count: 3,
      items: ["a", "b"],
      tools: { node: "latest", bun: { version: "1.2.3", enabled: false } },
      targets: [{ name: "first" }, { name: "second" }],
    }) as Parsed;

console.log(parsed.title);
console.log(parsed.enabled);
console.log(parsed.count);
console.log(parsed.items.join(","));
console.log(typeof parsed.tools.node === "string" ? parsed.tools.node : parsed.tools.node.version);
console.log(typeof parsed.tools.bun === "object" ? parsed.tools.bun.version : "missing");
console.log(parsed.targets.map((target) => target.name).join(","));

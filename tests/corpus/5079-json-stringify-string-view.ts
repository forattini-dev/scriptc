const manifest: Record<string, unknown> = { name: "demo", version: 2 };
const newline = "\r\n";
const rendered = JSON.stringify(manifest, null, "  ").replaceAll("\n", newline);
console.log(rendered.includes("demo"));

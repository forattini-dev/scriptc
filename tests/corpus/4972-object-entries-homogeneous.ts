const bins: Record<string, string> = { red: "dist/red.js", blue: "dist/blue.js" };
const shared = Object.entries(bins).filter(([name]) => name !== "blue");
console.log(shared.map(([name, path]) => `${name}:${path}`).join(","));

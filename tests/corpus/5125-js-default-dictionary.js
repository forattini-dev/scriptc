// @ts-nocheck
const defaults = { "=": "data", ":=": { to: "data", typed: true }, ":": "meta" };

function describe(separators = defaults) {
  return Object.keys(separators).join(",");
}

function tokenize(config = {}) {
  return describe(config.separators ?? defaults);
}

/** @param {{ separators?: Record<string, string | { to: string, typed?: boolean, prefix?: boolean }> }} options */
function parse(options) {
  return describe(options.separators ?? defaults);
}

console.log(parse({ separators: { "!": "custom", "?": "other" } }));
console.log(parse({}));
console.log(tokenize({ separators: { "@": "custom" } }));
console.log(describe());
console.log(describe(undefined));

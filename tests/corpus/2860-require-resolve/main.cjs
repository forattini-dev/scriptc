// CommonJS resolution introspection returns filenames without evaluating the
// target. The options.paths form searches from its supplied directories, and
// missing requests throw Node's catchable MODULE_NOT_FOUND shape.
console.log("relative", require.resolve("./cfg.json"));
console.log("builtins", require.resolve("fs"), require.resolve("node:path"));
console.log("core paths", require.resolve.paths("fs"));
console.log("relative paths", JSON.stringify(require.resolve.paths("./cfg.json")));
console.log(
  "custom paths",
  require.resolve("fs", {
    paths: ["tests/corpus/2860-require-resolve/vendor"],
  }),
);
try {
  require.resolve("./missing.cjs");
  console.log("unexpected resolution");
} catch (error) {
  console.log("missing", error.code, error.message.split("\n")[0]);
}

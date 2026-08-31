const moduleLike = { exports: "" };

(function (root, build) {
  typeof moduleLike == "object" && typeof moduleLike.exports < "u"
    ? moduleLike.exports = build()
    : typeof define == "function" && define.amd
      ? define(build)
      : console.log(root, build());
})("browser", () => "commonjs");

console.log(moduleLike.exports);

const host = typeof globalThis < "u"
  ? globalThis
  : typeof window < "u"
    ? window
    : typeof self < "u"
      ? self
      : {};

console.log(host === globalThis);

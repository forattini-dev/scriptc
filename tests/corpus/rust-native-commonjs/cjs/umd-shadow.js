(function (factory) {
  if (typeof exports === "object") {
    factory(exports);
  } else {
    (function () {
      var exports = {};
      factory(exports);
    })();
  }
})(function (target) {
  target.answer = 42;
});

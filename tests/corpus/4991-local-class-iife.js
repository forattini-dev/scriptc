var Factory = (function() {
  class Local {
    constructor(/** @type {string} */ value) {
      this.value = value;
    }

    read() {
      return this.value;
    }
  }

  // @ts-ignore JavaScript prototype data is intentionally introduced here.
  Local.prototype.defaults = { suffix: "!" };
  return Local;
})();

var value = new Factory("native");
// @ts-ignore The instance observes the inherited prototype data.
console.log(value.read() + value.defaults.suffix);

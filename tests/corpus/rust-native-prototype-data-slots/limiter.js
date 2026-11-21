var Limiter;

Limiter = (function() {
  class Limiter {
    constructor(options = {}) {
      this.options = Object.assign({}, this.storeDefaults, options);
    }

    async pick(reachedHighWater) {
      var strategy;
      ({strategy} = (await this._submit()));
      if (!reachedHighWater) {
        return "queued";
      }
      return strategy === Limiter.prototype.strategy.LEAK ? "leak" : strategy === Limiter.prototype.strategy.BLOCK ? "block" : "overflow";
    }

    async _submit() {
      return {strategy: this.options.strategy};
    }
  }

  Limiter.default = Limiter;

  Limiter.strategy = Limiter.prototype.strategy = {
    LEAK: 1,
    OVERFLOW: 2,
    BLOCK: 3
  };

  Limiter.prototype.storeDefaults = {
    maxConcurrent: null,
    strategy: Limiter.prototype.strategy.LEAK
  };

  return Limiter;
}).call(this);

var Limiter_1 = Limiter;

export { Limiter_1 as Limiter };

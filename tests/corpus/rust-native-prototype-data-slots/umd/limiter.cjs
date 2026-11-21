(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
	typeof define === 'function' && define.amd ? define(factory) :
	(global.Limiter = factory());
}(this, (function () { 'use strict';
	var Limiter;
	
	Limiter = (function() {
	  class Limiter {
	    constructor(options = {}) {
	      this.options = Object.assign({}, this.storeDefaults, options);
	      this.pick = this.pick.bind(this);
	    }
	
	    async pick(reachedHighWater) {
	      var strategy;
	      ({strategy} = (await this._submit()));
	      if (!reachedHighWater) {
	        return "queued";
	      }
	      return strategy === Limiter.prototype.strategy.LEAK ? "leak" : strategy === Limiter.prototype.strategy.BLOCK ? "block" : "overflow";
	    }
	
	    schedule(task, argument) {
	      return task(argument);
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
	
	return Limiter_1;
})));

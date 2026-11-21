module.exports = class WrapHandler {
  constructor(handler) {
    this.handler = handler;
  }

  static wrap(handler) {
    return handler.ready ? handler : new WrapHandler(handler);
  }
};

const WrapHandler = module.exports;
const original = { ready: true };
const wrapped = WrapHandler.wrap({ ready: false });
console.log(WrapHandler.wrap(original) === original, wrapped instanceof WrapHandler, wrapped.handler.ready);

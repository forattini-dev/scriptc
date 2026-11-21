module.exports = class WrapHandler {
  constructor(handler) {
    this.handler = handler
  }

  static wrap(handler) {
    return handler.ready ? handler : new WrapHandler(handler)
  }
}

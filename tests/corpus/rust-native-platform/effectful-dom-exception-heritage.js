function createInheritableDOMException() {
  class Test extends DOMException {
    get reason() {
      return "";
    }
  }

  if (new Test().reason !== undefined) {
    return DOMException;
  }

  return new Proxy(DOMException, {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, target);
      Object.setPrototypeOf(instance, newTarget.prototype);
      return instance;
    },
  });
}

class NativeWebSocketError extends createInheritableDOMException() {
  constructor(message = "") {
    super(message, "WebSocketError");
  }
}

const error = new NativeWebSocketError("broken");
console.log(
  error instanceof NativeWebSocketError,
  error instanceof DOMException,
  error.name,
  error.message,
);

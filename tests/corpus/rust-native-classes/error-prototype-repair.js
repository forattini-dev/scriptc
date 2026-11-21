class DerivedError extends Error {
  constructor(message) {
    super(message);
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "DerivedError";
  }
}

const error = new DerivedError("test");
console.log(error instanceof DerivedError, error.toString());

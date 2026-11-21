// @ts-nocheck

const ResponseError = class extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.code = 42;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
};

const error = new ResponseError("native");
console.log(`${error.name}|${error.message}|${error.code}|${error instanceof Error}`);

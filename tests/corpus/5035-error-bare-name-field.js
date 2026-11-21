// @ts-nocheck
class RequestError extends Error {
  name;

  constructor() {
    super("boom");
    console.log(this.name === undefined);
    this.name = "HttpError";
  }
}

const error = new RequestError();
console.log(error.name);
console.log(error.message);

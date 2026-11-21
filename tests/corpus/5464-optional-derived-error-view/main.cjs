const { deliver } = require("./util.cjs");

class CustomError extends Error {
  constructor(message) {
    super(message);
    this.name = "CustomError";
  }
}

deliver(
  {
    destroy(error) {
      console.log(error.name, error.message);
    },
  },
  new CustomError("boom"),
);

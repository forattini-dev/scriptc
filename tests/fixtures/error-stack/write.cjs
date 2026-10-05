class CustomError extends Error {
  constructor() {
    super("message");
    if (typeof Error.captureStackTrace === "function") Error.captureStackTrace(this);
    else this.stack = "fallback";
  }
}
const error = new CustomError();
try {
  Object.assign(error, { stack: "manual" });
  console.log(error.stack);
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.log(error.message);
}

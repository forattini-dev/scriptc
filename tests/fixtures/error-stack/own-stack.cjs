class CustomError extends Error { stack = "own"; }
const error = new CustomError("message");
Error.captureStackTrace(error);
console.log(error.stack.split("\n")[0]);

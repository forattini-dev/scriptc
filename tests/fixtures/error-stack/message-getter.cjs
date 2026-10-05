class CustomError extends Error { get message() { return "getter"; } }
const error = new CustomError();
Error.captureStackTrace(error);
console.log(error.stack.split("\n")[0]);

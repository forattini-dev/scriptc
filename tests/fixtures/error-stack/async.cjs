async function make() {
  await Promise.resolve();
  const error = new Error("async");
  Error.captureStackTrace(error);
  console.log(error.stack.split("\n")[0]);
}
make();

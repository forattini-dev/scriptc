/**
 * @param {*} Constructor
 * @param {*} executor
 */
function construct(Constructor, executor) {
  return new Constructor(executor);
}

/** @param {(value: string) => void} resolve */
function executor(resolve) {
  resolve("ready");
}

/** @param {string} value */
function show(value) {
  console.log(value);
}

construct(Promise, executor).then(show);

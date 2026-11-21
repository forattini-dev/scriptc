/** @param {any} value */
async function hook(value) {
  return value;
}

/** @type {(value: any) => any} */
const erased = hook;
console.log(typeof erased === "function");

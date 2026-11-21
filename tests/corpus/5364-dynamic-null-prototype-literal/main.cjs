/** @type {Record<string, () => number>} */
const table = {
  __proto__: null,
  first: () => 1,
  second: () => 2
}

console.log(Object.getPrototypeOf(table) === null, table.first(), table.second())

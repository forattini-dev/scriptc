export {};

/**
 * @param {any[]} rows
 * @param {string} value
 */
function append(rows, value) {
  rows[rows.length - 1] += value;
}

const rows = ["a"];
append(rows, "b");
console.log(rows.join(","));

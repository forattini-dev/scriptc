/** @param {number} code */
function describe(code) {
  if (code === null) return 'null';
  if (code === undefined) return 'undefined';
  return String(code);
}

module.exports = { describe };

/** @param {number} value @returns {number} */
function parse(value) { return value * 2; }
const bound = parse.bind(null);
export const endpoint = Object.assign(bound, { offset: 3, parse });

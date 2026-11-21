/** @param {any} value @returns {Promise<any>} */
export function make(value) {
  return Promise.resolve({ value });
}

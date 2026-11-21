/**
 * @param {import("stream").Stream} target
 * @param {Error} [error]
 */
function deliver(target, error) {
  if (error) {
    target.destroy(error);
  }
}

module.exports = { deliver };

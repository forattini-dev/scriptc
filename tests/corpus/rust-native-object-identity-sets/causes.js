/**
 * @param {Error} err
 * @param {Set<Error>} seen
 * @returns {string}
 */
const stackWithCausesInner = (err, seen) => {
  const stack = err.message || '';
  if (seen.has(err)) {
    return stack + ' / causes have become circular...';
  }
  const cause = err.cause;
  if (cause instanceof Error) {
    seen.add(err);
    return stack + ' / caused by: ' + stackWithCausesInner(cause, seen);
  }
  return stack;
};

/**
 * @param {Error} err
 * @returns {string}
 */
export const stackWithCauses = (err) => stackWithCausesInner(err, new Set());

/** @param {number} fallback */
function makeValueReader(fallback) {
  const ValueReader = class ValueReader {
    read() {
      return fallback;
    }
  };
  return new ValueReader();
}

console.log(makeValueReader(5).read());

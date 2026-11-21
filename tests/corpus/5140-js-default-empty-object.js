// @ts-nocheck
/**
 * @param factory creates an item
 * @param reset resets an item
 */
function createPool(factory, reset, options = {}) {
  const { initialSize = 2, maxSize = 4 } = options;
  const values = [];
  for (let index = 0; index < initialSize; index++) values.push(factory());
  return values.length + maxSize;
}

createPool(() => 1, () => {}, { initialSize: 3, maxSize: 8 });

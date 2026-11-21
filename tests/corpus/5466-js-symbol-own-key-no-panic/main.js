function hasSafeIterator(obj) {
  const prototype = Object.getPrototypeOf(obj);
  const ownIterator = Object.prototype.hasOwnProperty.call(obj, Symbol.iterator);
  return (
    ownIterator ||
    (prototype != null &&
      prototype !== Object.prototype &&
      typeof obj[Symbol.iterator] === "function")
  );
}

console.log(hasSafeIterator([1]), hasSafeIterator({ value: 1 }));
